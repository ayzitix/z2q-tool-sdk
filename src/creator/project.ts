import type { ManifestCapabilities, ToolManifest } from '../types.js';
import { describeCapabilities } from './capabilities.js';
import { ToolCreatorError, resolveToolRequest } from './prompt.js';
import type { ToolRequest } from './prompt.js';
import {
  assessToolManifest,
  buildToolProject,
  formatSourceIssues,
  reviewToolSource,
} from './review.js';
import type { ToolSourceReport } from './review.js';

export interface ToolProjectOptions {
  dir: string;
  request: ToolRequest;
  source: string;
  cwd?: string;
}

export interface ToolProjectResult {
  dir: string;
  entry: string;
  report: ToolSourceReport;
  manifest: ToolManifest;
}

/** What `scaffoldToolProject` wrote. No build, no import, no execution. */
export interface ToolProjectScaffold {
  dir: string;
  entry: string;
  files: string[];
}

interface ProjectFacts {
  name: string;
  version: string;
  description: string;
  capabilities: ManifestCapabilities;
}

/**
 * Write the six project files after a static review, without building.
 *
 * This is the CLI's `create --write` skeleton and the first half of
 * `createToolProject`. The source must already pass every static rule, so a
 * hostile source is never written and never imported.
 */
export async function scaffoldToolProject(
  options: ToolProjectOptions,
): Promise<ToolProjectScaffold> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const request = resolveToolRequest(options.request);
  const report = reviewToolSource(options.source);
  if (!report.ok) {
    throw new ToolCreatorError(
      'invalid_source',
      `source failed review: ${formatSourceIssues(report.issues)}`,
      { report },
    );
  }
  if (report.name !== undefined && report.name !== request.name) {
    throw new ToolCreatorError(
      'name_mismatch',
      `source declares "${report.name}", but the request asked for "${request.name}"`,
      { report },
    );
  }

  const dir = path.resolve(options.cwd ?? process.cwd(), options.dir);
  await assertEmptyDirectory(dir);
  await fs.mkdir(dir, { recursive: true });
  const facts: ProjectFacts = {
    name: report.name ?? request.name,
    version: report.version ?? '0.1.0',
    description: report.description ?? request.purpose,
    capabilities: report.capabilities ?? emptyCapabilities(),
  };
  const files = await writeProjectFiles(dir, options.source, request, facts);
  return { dir, entry: path.join(dir, 'tool.ts'), files };
}

/**
 * Write the project, build it, and confirm the manifest.
 *
 * Static review runs before anything is written. The build reads the source in
 * QuickJS (that is how `buildTool` reads the definition), so it only starts
 * after every static rule passed and never imports the entry on the host. A
 * post-build manifest failure leaves the scaffold and dist in place and throws
 * `invalid_source`: the caller must not install it.
 */
export async function createToolProject(
  options: ToolProjectOptions,
): Promise<ToolProjectResult> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const request = resolveToolRequest(options.request);
  const staticReport = reviewToolSource(options.source);
  if (!staticReport.ok) {
    throw new ToolCreatorError(
      'invalid_source',
      `source failed review: ${formatSourceIssues(staticReport.issues)}`,
      { report: staticReport },
    );
  }
  if (staticReport.name !== undefined && staticReport.name !== request.name) {
    throw new ToolCreatorError(
      'name_mismatch',
      `source declares "${staticReport.name}", but the request asked for "${request.name}"`,
      { report: staticReport },
    );
  }

  const dir = path.resolve(options.cwd ?? process.cwd(), options.dir);
  await assertEmptyDirectory(dir);
  await fs.mkdir(dir, { recursive: true });

  const facts: ProjectFacts = {
    name: staticReport.name ?? request.name,
    version: staticReport.version ?? '0.1.0',
    description: staticReport.description ?? request.purpose,
    capabilities: staticReport.capabilities ?? emptyCapabilities(),
  };
  await writeProjectFiles(dir, options.source, request, facts);

  let built;
  try {
    built = await buildToolProject(dir);
  } catch (error) {
    throw new ToolCreatorError('build_failed', buildMessage(error), { cause: error });
  }

  const report = assessToolManifest(built.manifest);
  if (!report.ok) {
    throw new ToolCreatorError(
      'invalid_source',
      `built manifest failed review: ${formatSourceIssues(report.issues)}`,
      { report },
    );
  }
  if (built.manifest.name !== request.name) {
    throw new ToolCreatorError(
      'name_mismatch',
      `source declares "${built.manifest.name}", but the request asked for "${request.name}"`,
      { report },
    );
  }

  // The manifest is authoritative for the package and the README. This second
  // write keeps them right even when the source did not spell name/version out.
  const manifestFacts: ProjectFacts = {
    name: built.manifest.name,
    version: built.manifest.version,
    description: built.manifest.description,
    capabilities: built.manifest.capabilities,
  };
  await writePackageJson(dir, manifestFacts);
  await writeTestFile(dir, manifestFacts);
  await writeReadme(dir, request, manifestFacts);

  return {
    dir,
    entry: path.join(dir, 'tool.ts'),
    report,
    manifest: built.manifest,
  };
}

/**
 * A valid, reviewed placeholder for `z1-tool create --write` when the host has
 * not supplied generated source yet. The host replaces `tool.ts` and runs the
 * creator again.
 */
export function placeholderToolSource(request: ToolRequest): string {
  const resolved = resolveToolRequest(request);
  const description = `${resolved.purpose} Generated by the z1 Tool Creator.`.slice(0, 500);
  return `import { defineTool } from 'z1-tool-sdk';
import { z } from 'zod';

export const tool = defineTool({
  name: ${JSON.stringify(resolved.name)},
  version: '0.1.0',
  description: ${JSON.stringify(description)},
  parameters: z.object({}),
  capabilities: {},
  // Replace this placeholder with the host's generated run function.
  run: async () => ({ ok: true }),
});
`;
}

async function writeProjectFiles(
  dir: string,
  source: string,
  request: ToolRequest,
  facts: ProjectFacts,
): Promise<string[]> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const files: Record<string, string> = {
    'tool.ts': source.endsWith('\n') ? source : `${source}\n`,
    'package.json': packageJsonText(facts),
    'tsconfig.json': TSCONFIG_TEMPLATE,
    'README.md': readmeText(request, facts),
    'tool.test.ts': testTemplate(facts),
    '.gitignore': 'node_modules\ndist\n*.tgz\ncoverage\n',
  };
  const written: string[] = [];
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.writeFile(file, contents, 'utf8');
    written.push(file);
  }
  return written;
}

async function writePackageJson(dir: string, facts: ProjectFacts): Promise<void> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  await fs.writeFile(path.join(dir, 'package.json'), packageJsonText(facts), 'utf8');
}

async function writeTestFile(dir: string, facts: ProjectFacts): Promise<void> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  await fs.writeFile(path.join(dir, 'tool.test.ts'), testTemplate(facts), 'utf8');
}

async function writeReadme(
  dir: string,
  request: ToolRequest,
  facts: ProjectFacts,
): Promise<void> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  await fs.writeFile(path.join(dir, 'README.md'), readmeText(request, facts), 'utf8');
}

function packageJsonText(facts: ProjectFacts): string {
  return `${JSON.stringify(
    {
      name: facts.name,
      version: facts.version,
      private: true,
      type: 'module',
      scripts: {
        build: 'z1-tool build',
        test: 'vitest run',
        pack: 'z1-tool pack',
      },
      dependencies: {
        'z1-tool-sdk': '^0.1.0',
        zod: '^4.6.7',
      },
      devDependencies: {
        esbuild: '^0.28.2',
        typescript: '^5.9.3',
        vitest: '^4.1.12',
      },
    },
    null,
    2,
  )}\n`;
}

function readmeText(request: ToolRequest, facts: ProjectFacts): string {
  const summary = describeCapabilities({
    schemaVersion: 1,
    name: facts.name,
    version: facts.version,
    description: facts.description,
    parameters: {},
    capabilities: facts.capabilities,
  });
  return [
    `# ${facts.name}`,
    '',
    facts.description,
    '',
    'Generated by the z1 Tool Creator. The model call is the host\'s job; this',
    'project is the reviewed source, its package and its build.',
    '',
    '## Capabilities',
    '',
    ...summary.lines.map((line) => `- ${line}`),
    '',
    `Risk: ${summary.risk}.`,
    '',
    'Capabilities are declarations. The runtime broker decides what to allow;',
    'the SDK never grants anything itself.',
    '',
    '## Build and run',
    '',
    '~~~sh',
    'npm install',
    'npx z1-tool build',
    'npx z1-tool test',
    'npx z1-tool run . --workspace ../my-project',
    '~~~',
    '',
    `Requested purpose: ${request.purpose}`,
    '',
  ].join('\n');
}

function testTemplate(facts: ProjectFacts): string {
  return `import { describe, expect, it } from 'vitest';
import { tool } from './tool.js';

describe('${facts.name}', () => {
  it('declares the expected manifest', () => {
    expect(tool.manifest.name).toBe('${facts.name}');
    expect(tool.manifest.version).toBe('${facts.version}');
    expect(tool.manifest.description.length).toBeGreaterThanOrEqual(20);
  });

  it('declares no network access', () => {
    expect(tool.manifest.capabilities.net.hosts).toEqual([]);
  });

  // Add behaviour tests with createTestContext from 'z1-tool-sdk'.
});
`;
}

async function assertEmptyDirectory(dir: string): Promise<void> {
  const fs = await import('node:fs/promises');
  const info = await fs.stat(dir).catch(() => undefined);
  if (info === undefined) return;
  if (!info.isDirectory()) {
    throw new ToolCreatorError('project_not_empty', `not a directory: ${dir}`);
  }
  const entries = await fs.readdir(dir);
  if (entries.length > 0) {
    throw new ToolCreatorError('project_not_empty', `directory is not empty: ${dir}`);
  }
}

function buildMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const detail = lines.find((line) => line.includes('ERROR:')) ?? lines[0] ?? 'the build failed';
  return detail.length > 500 ? `${detail.slice(0, 500)}...` : detail;
}

function emptyCapabilities(): ManifestCapabilities {
  return {
    fs: { read: [], write: [] },
    process: { argv: [] },
    net: { hosts: [] },
    limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576 },
  };
}

const TSCONFIG_TEMPLATE = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["tool.ts", "tool.test.ts"]
}
`;
