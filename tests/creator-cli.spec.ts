import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, tempDir } from './runtime-helpers.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'dist', 'cli.js');

const PURPOSE = 'Read a workspace file and return its length in characters.';

let base: string;
let workspace: string;
let sourceFile: string;
let badSource: string;
let bigSource: string;
let throwingSource: string;
let deniedSource: string;
let builtDir: string;

beforeAll(async () => {
  await mkdir(join(repoRoot, 'dist'), { recursive: true });
  await esbuild.build({
    entryPoints: [join(repoRoot, 'src', 'cli.ts')],
    outfile: cliPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['esbuild', 'quickjs-emscripten'],
    logLevel: 'silent',
  });

  base = await tempDir('z1-creator-cli-');
  workspace = join(base, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'a.txt'), 'hello\nworld\n', 'utf8');

  sourceFile = join(base, 'source.ts');
  await writeFile(
    sourceFile,
    `import { defineTool } from 'z1-tool-sdk';
import { z } from 'zod';

export const tool = defineTool({
  name: 'tool.cli-demo',
  version: '0.1.0',
  description: 'Read a workspace file and return its length in characters.',
  parameters: z.object({ path: z.string() }),
  capabilities: { fs: { read: ['**/*'] } },
  run: async (ctx, args) => ({ path: args.path, length: (await ctx.fs.read(args.path)).length }),
});
`,
    'utf8',
  );
  badSource = join(base, 'bad.ts');
  await writeFile(
    badSource,
    `import { defineTool } from 'z1-tool-sdk';
import { z } from 'zod';

export const tool = defineTool({
  name: 'tool.cli-bad',
  version: '0.1.0',
  description: 'Reads the host environment, which the review must refuse.',
  parameters: z.object({}),
  capabilities: {},
  run: async () => ({ home: process.env.HOME }),
});
`,
    'utf8',
  );
  bigSource = join(base, 'big.ts');
  await writeFile(bigSource, 'x'.repeat(33 * 1024), 'utf8');

  deniedSource = join(base, 'denied.ts');
  await writeFile(
    deniedSource,
    `import { defineTool } from 'z1-tool-sdk';
import { z } from 'zod';

export const tool = defineTool({
  name: 'tool.cli-denied',
  version: '0.1.0',
  description: 'Catches a policy refusal and claims success, which smoke must not hide.',
  parameters: z.object({}),
  capabilities: {},
  run: async (ctx) => {
    try { await ctx.process.run({ argv: ['cmd'] }); } catch {}
    return { ok: true };
  },
});
`,
    'utf8',
  );

  throwingSource = join(base, 'throwing.ts');
  await writeFile(
    throwingSource,
    `import { defineTool } from 'z1-tool-sdk';
import { z } from 'zod';

export const tool = defineTool({
  name: 'tool.cli-throws',
  version: '0.1.0',
  description: 'Always throws, so the smoke test can measure tool_threw.',
  parameters: z.object({}),
  capabilities: {},
  run: async () => {
    throw new Error('boom');
  },
});
`,
    'utf8',
  );

  builtDir = join(base, 'built');
  const created = await runCli([
    'create',
    builtDir,
    '--purpose',
    PURPOSE,
    '--name',
    'tool.cli-demo',
    '--source',
    sourceFile,
    '--write',
  ]);
  expect(created.code, created.stderr).toBe(0);
}, 60_000);

afterAll(async () => {
  await cleanupTempDirs();
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd = base): Promise<CliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', rejectPromise);
    child.once('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

async function exists(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  return info !== undefined;
}

describe('z1-tool create', () => {
  it('prints the prompt without writing unless --write is given', async () => {
    const target = join(base, 'prompt-only');

    const result = await runCli([
      'create',
      target,
      '--purpose',
      'Find TODO comments in workspace files.',
      '--name',
      'find todos',
      '--examples',
      '[{"input":{"glob":"**/*"},"note":"all files"}]',
      '--print-prompt',
    ]);

    expect(result.code, result.stderr).toBe(0);
    for (const needle of [
      'defineTool',
      'capabilities',
      'ctx.fs.read',
      'ctx.process.run',
      'tool.find-todos',
      'all files',
    ]) {
      expect(result.stdout, needle).toContain(needle);
    }
    expect(await exists(target)).toBe(false);
  });

  it('writes a reviewed six-file skeleton and no dist without --source', async () => {
    const target = join(base, 'skeleton');

    const created = await runCli([
      'create',
      target,
      '--purpose',
      PURPOSE,
      '--name',
      'tool.skeleton',
      '--write',
    ]);

    expect(created.code, created.stderr).toBe(0);
    expect(created.stdout).toContain(`created ${target}`);
    expect((await readdir(target)).sort()).toEqual([
      '.gitignore',
      'README.md',
      'package.json',
      'tool.test.ts',
      'tool.ts',
      'tsconfig.json',
    ]);
    expect(await exists(join(target, 'dist'))).toBe(false);

    const reviewed = await runCli(['review', target]);
    expect(reviewed.code, reviewed.stderr).toBe(0);
    expect(reviewed.stdout).toContain('review ok: tool.skeleton@0.1.0');
  });

  it('writes and builds the host file with --source', async () => {
    const manifest = JSON.parse(
      await import('node:fs/promises').then((fs) =>
        fs.readFile(join(builtDir, 'dist', 'tool.json'), 'utf8'),
      ),
    ) as { name: string; version: string };

    expect(manifest).toMatchObject({ name: 'tool.cli-demo', version: '0.1.0' });
    expect(await exists(join(builtDir, 'dist', 'index.js'))).toBe(true);
  });
});

describe('z1-tool review', () => {
  it('prints one line per issue and exits 1', async () => {
    const text = await runCli(['review', badSource]);

    expect(text.code).toBe(1);
    expect(text.stdout).toBe('');
    expect(text.stderr).toContain('forbidden_identifier');

    const json = await runCli(['review', badSource, '--json']);
    expect(json.code).toBe(1);
    const report = JSON.parse(json.stdout) as { ok: boolean; issues: { code: string }[] };
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain('forbidden_identifier');
  });

  it('refuses a 33 KiB source and accepts the generated project', async () => {
    const big = await runCli(['review', bigSource]);
    expect(big.code).toBe(1);
    expect(big.stderr).toContain('source_too_large');

    const good = await runCli(['review', builtDir]);
    expect(good.code, good.stderr).toBe(0);
    expect(good.stdout).toContain('review ok: tool.cli-demo@0.1.0');
  });
});

describe('z1-tool smoke', () => {
  it('runs the sample in the sandbox and prints its JSON value', async () => {
    const result = await runCli([
      'smoke',
      builtDir,
      '--args',
      '{"path":"a.txt"}',
      '--workspace',
      workspace,
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('run 1: ok');
    expect(result.stdout).toContain('"length":12');
    expect(result.stdout).toContain('smoke: 1/1 ok');
  });

  it('prints the denial count when a tool catches a refusal', async () => {
    const target = join(base, 'denied');
    const created = await runCli([
      'create',
      target,
      '--purpose',
      'Catches a policy refusal and claims success, which smoke must not hide.',
      '--name',
      'tool.cli-denied',
      '--source',
      deniedSource,
      '--write',
    ]);
    expect(created.code, created.stderr).toBe(0);

    const result = await runCli(['smoke', target]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('denied 1');
    expect(result.stdout).toContain('smoke: 0/1 ok');
  });

  it('reports tool_threw and exits 1 for a throwing tool', async () => {
    const target = join(base, 'throwing');
    const created = await runCli([
      'create',
      target,
      '--purpose',
      'Always throws, so the smoke test can measure tool_threw.',
      '--name',
      'tool.cli-throws',
      '--source',
      throwingSource,
      '--write',
    ]);
    expect(created.code, created.stderr).toBe(0);

    const result = await runCli(['smoke', target]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('tool_threw');
    expect(result.stdout).toContain('smoke: 0/1 ok');
  });
});

describe('z1-tool install / installed', () => {
  it('installs behind approval.json and lists it back', async () => {
    const toolsDir = join(base, 'tools');

    const installed = await runCli([
      'install',
      builtDir,
      '--tools',
      toolsDir,
      '--approved-by',
      'reviewer',
    ]);

    expect(installed.code, installed.stderr).toBe(0);
    expect(installed.stdout).toContain('installed tool.cli-demo@0.1.0');
    expect(installed.stdout).toContain('Reads workspace files matching "**/*".');
    expect(installed.stdout).toContain('risk: read-only');
    expect(installed.stdout).toContain(`path: ${join(toolsDir, 'tool.cli-demo', '0.1.0')}`);
    expect(await exists(join(toolsDir, 'tool.cli-demo', '0.1.0', 'approval.json'))).toBe(true);

    const listed = await runCli(['installed', '--tools', toolsDir]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('tool.cli-demo@0.1.0');
    expect(listed.stdout).toContain('approved-by=reviewer');
    expect(listed.stdout).toContain(`path=${join(toolsDir, 'tool.cli-demo', '0.1.0')}`);

    const again = await runCli(['install', builtDir, '--tools', toolsDir]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('z1-tool: version_exists:');
  });

  it('says so when nothing is installed', async () => {
    const result = await runCli(['installed', '--tools', join(base, 'empty-tools')]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('no tools installed in');
  });

  it('defaults --tools to <cwd>/.z2q/tools, the creator root, and prints where it resolved', async () => {
    const project = join(base, 'hand-installed');
    await mkdir(project, { recursive: true });
    const defaultTools = join(project, '.z2q', 'tools');

    const empty = await runCli(['installed'], project);
    expect(empty.code, empty.stderr).toBe(0);
    // A hand-installed proposal lands where the creator looks, not in `./.z1/tools`.
    expect(empty.stdout).toContain(`no tools installed in ${defaultTools}`);
    expect(empty.stdout).not.toContain('.z1');

    const installed = await runCli(['install', builtDir, '--approved-by', 'me'], project);
    expect(installed.code, installed.stderr).toBe(0);
    expect(installed.stdout).toContain(
      `path: ${join(defaultTools, 'tool.cli-demo', '0.1.0')}`,
    );
    expect(await exists(join(defaultTools, 'tool.cli-demo', '0.1.0', 'approval.json'))).toBe(true);

    const listed = await runCli(['installed'], project);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(`tools: ${defaultTools}`);
  });
});
