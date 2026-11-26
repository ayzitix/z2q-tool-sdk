import { createHash } from 'node:crypto';
import { cp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeCapabilities } from '../src/creator/capabilities.js';
import { installTool, listInstalledTools, loadInstalledTool } from '../src/creator/install.js';
import { ToolCreatorError } from '../src/creator/prompt.js';
import { createToolProject } from '../src/creator/project.js';
import type { ToolManifest } from '../src/index.js';
import { createToolRuntime } from '../src/runtime/index.js';
import {
  cleanupTempDirs,
  rawManifest,
  rawToolSource,
  tempDir,
  writeRawPackage,
} from './runtime-helpers.js';

afterAll(async () => {
  await cleanupTempDirs();
});

const PURPOSE = 'Read a workspace file and return its length in characters.';
const NAME = 'tool.install-demo';
const INSTALLED_AT = '2026-01-02T03:04:05.000Z';

let base: string;
let projectDir: string;
let manifest: ToolManifest;

beforeAll(async () => {
  base = await tempDir('z1-creator-install-');
  projectDir = join(base, 'project');
  const source = `import { defineTool } from 'z1-tool-sdk';
import { z } from 'zod';

export const tool = defineTool({
  name: '${NAME}',
  version: '0.1.0',
  description: 'Read a workspace file and return its length in characters.',
  parameters: z.object({ path: z.string().default('a.txt') }),
  capabilities: { fs: { read: ['**/*'] }, limits: { timeoutMs: 5000 } },
  run: async (ctx, args) => {
    const text = await ctx.fs.read(args.path);
    return { path: args.path, length: text.length };
  },
});
`;
  const result = await createToolProject({
    dir: projectDir,
    request: { name: NAME, purpose: PURPOSE },
    source,
  });
  manifest = result.manifest;
});

async function rejection(promise: Promise<unknown>): Promise<ToolCreatorError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolCreatorError);
    return error as ToolCreatorError;
  }
  throw new Error('expected the call to reject, but it resolved');
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function exists(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  return info !== undefined;
}

function install(toolsDir: string, extra: Record<string, unknown> = {}) {
  return installTool({
    toolsDir,
    dir: projectDir,
    approvedBy: 'reviewer',
    now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
    ...extra,
  });
}

interface ApprovalJson {
  schemaVersion: number;
  name: string;
  version: string;
  sha256: string;
  capabilities: unknown;
  installedAt: string;
  approvedBy?: string;
}

describe('installTool', () => {
  it('writes <tools>/<name>/<version>/{dist/*,approval.json} and nothing else', async () => {
    const toolsDir = join(base, 'tools-layout');

    const installed = await install(toolsDir);

    expect(installed.name).toBe(NAME);
    expect(installed.version).toBe('0.1.0');
    expect(installed.path).toBe(join(toolsDir, NAME, '0.1.0'));
    expect(installed.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(installed.installedAt).toBe(INSTALLED_AT);
    expect(installed.capabilities).toEqual(manifest.capabilities);
    expect(installed.approvedBy).toBe('reviewer');

    expect((await readdir(installed.path)).sort()).toEqual(['approval.json', 'dist']);
    expect((await readdir(join(installed.path, 'dist'))).sort()).toEqual(['index.js', 'tool.json']);

    const approval = JSON.parse(
      await readFile(join(installed.path, 'approval.json'), 'utf8'),
    ) as ApprovalJson;
    expect(approval).toEqual({
      schemaVersion: 1,
      name: NAME,
      version: '0.1.0',
      sha256: installed.sha256,
      capabilities: manifest.capabilities,
      installedAt: INSTALLED_AT,
      approvedBy: 'reviewer',
    });
  });

  it('lists what it installed and returns [] for a missing tools dir', async () => {
    const toolsDir = join(base, 'tools-list');
    const installed = await install(toolsDir);

    const listed = await listInstalledTools(toolsDir);

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: NAME,
      version: '0.1.0',
      path: installed.path,
      sha256: installed.sha256,
      installedAt: INSTALLED_AT,
      approvedBy: 'reviewer',
    });
    expect(await listInstalledTools(join(base, 'no-such-tools'))).toEqual([]);
  });

  it('loadInstalledTool returns a package the runtime can run', async () => {
    const toolsDir = join(base, 'tools-run');
    await install(toolsDir);
    const workspace = await tempDir('z1-creator-install-work-');
    await writeFile(join(workspace, 'a.txt'), 'hello\nworld\n', 'utf8');

    const pkg = await loadInstalledTool(toolsDir, NAME);
    expect(pkg.manifest.name).toBe(NAME);
    expect(pkg.manifest.capabilities.fs.read).toEqual(['**/*']);

    const runtime = await createToolRuntime({ workspace });
    const result = await runtime.run(pkg, { path: 'a.txt' });
    expect(result.value).toEqual({ path: 'a.txt', length: 12 });
  });

  it('refuses a tampered dist/index.js', async () => {
    const toolsDir = join(base, 'tools-tamper');
    const installed = await install(toolsDir);
    await writeFile(
      join(installed.path, 'dist', 'index.js'),
      `${await readFile(join(installed.path, 'dist', 'index.js'), 'utf8')}\n// tampered\n`,
      'utf8',
    );

    const error = await rejection(loadInstalledTool(toolsDir, NAME));

    expect(error.code).toBe('sha_mismatch');
  });

  it('refuses to install the same version twice and leaves the first approval alone', async () => {
    const toolsDir = join(base, 'tools-twice');
    const installed = await install(toolsDir);
    const approvalPath = join(installed.path, 'approval.json');
    const before = await readFile(approvalPath, 'utf8');

    const error = await rejection(install(toolsDir));

    expect(error.code).toBe('version_exists');
    expect(await readFile(approvalPath, 'utf8')).toBe(before);
  });

  it('refuses a capability mismatch and an unexpected sha', async () => {
    const capsDir = join(base, 'tools-caps');
    const expected = {
      ...manifest.capabilities,
      fs: { ...manifest.capabilities.fs, write: ['out/**'] },
    };
    const capsError = await rejection(install(capsDir, { expectCapabilities: expected }));
    expect(capsError.code).toBe('capabilities_mismatch');
    expect(await exists(join(capsDir, NAME, '0.1.0'))).toBe(false);

    const shaDir = join(base, 'tools-sha');
    const shaError = await rejection(install(shaDir, { expectSha256: '0'.repeat(64) }));
    expect(shaError.code).toBe('sha_mismatch');
    expect(await exists(join(shaDir, NAME, '0.1.0'))).toBe(false);
  });

  it('refuses an install whose tool.ts fails static review, even with a valid dist', async () => {
    const badDir = join(base, 'bad-source');
    await cp(projectDir, badDir, { recursive: true });
    await writeFile(
      join(badDir, 'tool.ts'),
      `import { defineTool } from 'z1-tool-sdk';
import { z } from 'zod';

export const tool = defineTool({
  name: '${NAME}',
  version: '0.1.0',
  description: 'Reads the host environment, which the review must refuse.',
  parameters: z.object({}),
  capabilities: {},
  run: async () => ({ home: process.env.HOME }),
});
`,
      'utf8',
    );
    const toolsDir = join(base, 'tools-unreviewed');

    const error = await rejection(installTool({ toolsDir, dir: badDir }));

    expect(error.code).toBe('invalid_source');
    expect(error.report?.issues[0]?.code).toBe('forbidden_identifier');
    expect(await exists(join(toolsDir, NAME, '0.1.0'))).toBe(false);
  });

  it('rebuilds tool.ts and never signs a stale dist/', async () => {
    const dir = await tempDir('z1-creator-stale-');
    await cp(projectDir, dir, { recursive: true });
    const foreign = rawManifest({ name: NAME, argv: ['cmd'] });
    await writeRawPackage(dir, rawToolSource(foreign, '({ ok: true })'), foreign);
    const staleSha = hash(await readFile(join(dir, 'dist', 'index.js')));
    const toolsDir = join(base, 'tools-stale');

    const installed = await install(toolsDir, { dir });

    expect(installed.capabilities.process.argv).toEqual([]);
    expect(installed.sha256).not.toBe(staleSha);
    const copied = await readFile(join(installed.path, 'dist', 'index.js'), 'utf8');
    expect(copied).not.toContain('["cmd"]');
    expect(copied).toBe(await readFile(join(dir, 'dist', 'index.js'), 'utf8'));
  });

  it('installs a dist-only directory only with expectSha256 or allowPrebuilt', async () => {
    const dir = await tempDir('z1-creator-prebuilt-');
    await cp(projectDir, dir, { recursive: true });
    await rm(join(dir, 'tool.ts'));
    const prebuilt = rawManifest({ name: NAME });
    await writeRawPackage(dir, rawToolSource(prebuilt, '({ ok: true })'), prebuilt);
    const sha = hash(await readFile(join(dir, 'dist', 'index.js')));

    const refused = await rejection(installTool({ toolsDir: join(base, 'tools-prebuilt-no'), dir }));
    expect(refused.code).toBe('invalid_arguments');
    expect(refused.message).toContain('allowPrebuilt');

    const pinned = await installTool({
      toolsDir: join(base, 'tools-prebuilt-sha'),
      dir,
      expectSha256: sha,
      now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    expect(pinned.sha256).toBe(sha);

    const allowed = await installTool({
      toolsDir: join(base, 'tools-prebuilt-allow'),
      dir,
      allowPrebuilt: true,
      now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    expect(allowed.sha256).toBe(sha);
  });
});

describe('installed versions', () => {
  it('refuses a manifest whose name is a reserved Windows device name', async () => {
    const dir = await tempDir('z1-install-device-');
    const manifest = rawManifest({ name: 'con' });
    await writeRawPackage(dir, rawToolSource(manifest, '({ ok: true })'), manifest);
    const toolsDir = join(await tempDir('z1-install-device-tools-'), 'tools');

    const error = await rejection(installTool({ toolsDir, dir, allowPrebuilt: true }));

    expect(error.code).toBe('invalid_name');
    expect(await stat(join(toolsDir, 'con')).catch(() => undefined)).toBeUndefined();
  });

  it('refuses to install through a junction at the tool directory', async () => {
    const fs = await import('node:fs/promises');
    const root = await tempDir('z1-install-link-');
    const toolsDir = join(root, 'tools');
    const outside = join(root, 'outside');
    await fs.mkdir(toolsDir, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, join(toolsDir, NAME), 'junction');

    const error = await rejection(installTool({ toolsDir, dir: projectDir }));

    expect(error.code).toBe('version_exists');
    expect(error.message).toContain('link');
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('lists every version and loads the highest when no version is given', async () => {
    const toolsDir = join(base, 'tools-versions');
    for (const version of ['0.1.0', '0.2.0']) {
      const dir = await tempDir(`z1-creator-raw-${version}-`);
      const raw: ToolManifest = { ...rawManifest({ name: 'tool.raw' }), version };
      await writeRawPackage(dir, rawToolSource(raw, '({ ok: true })'), raw);
      await installTool({
        toolsDir,
        dir,
        allowPrebuilt: true,
        now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
      });
    }

    const listed = await listInstalledTools(toolsDir);
    expect(listed.map((tool) => `${tool.name}@${tool.version}`)).toEqual([
      'tool.raw@0.1.0',
      'tool.raw@0.2.0',
    ]);

    const latest = await loadInstalledTool(toolsDir, 'tool.raw');
    expect(latest.manifest.version).toBe('0.2.0');
  });
});

describe('describeCapabilities', () => {
  it('names every granted surface and puts the risk in severity order', () => {
    const read = describeCapabilities(rawManifest({ read: ['**/*'] }));
    expect(read.risk).toBe('read-only');
    expect(read.lines[0]).toContain('Reads workspace files');
    expect(read.lines[0]).toContain('"**/*"');

    const writes = describeCapabilities(rawManifest({ write: ['dist/**'] }));
    expect(writes.risk).toBe('writes');
    expect(writes.lines[0]).toContain('Writes workspace files');

    const programs = describeCapabilities(rawManifest({ argv: ['adb', 'git'] }));
    expect(programs.risk).toBe('runs-programs');
    expect(programs.lines[0]).toContain('Runs these programs');

    const networkManifest = rawManifest();
    networkManifest.capabilities.net.hosts = ['api.example.com'];
    const network = describeCapabilities(networkManifest);
    expect(network.risk).toBe('network');
    expect(network.lines[0]).toContain('Fetches from these hosts');
    expect(network.lines[0]).toContain('"api.example.com"');
    expect(network.lines[0]).toContain('ctx.net.fetch');

    const secrets = rawManifest();
    secrets.capabilities.env.read = ['EXA_API_KEY'];
    const env = describeCapabilities(secrets);
    expect(env.risk).toBe('secrets');
    expect(env.lines[0]).toContain('Reads these environment variables');
    expect(env.lines[0]).toContain('"EXA_API_KEY"');
    expect(env.lines[0]).toContain('can leave in a request or a result');
  });

  it('describes a tool with no grants and keeps quoted values on one line', () => {
    const empty = describeCapabilities(rawManifest());
    expect(empty.risk).toBe('read-only');
    expect(empty.lines[0]).toContain('No filesystem, process, network or environment grants');
    expect(empty.lines).toHaveLength(3);

    const injected = rawManifest();
    injected.capabilities.fs.read = ['a\nb'];
    const summary = describeCapabilities(injected);
    expect(summary.lines.some((line) => line.includes('\n'))).toBe(false);
    expect(summary.lines[0]).toContain('"a\\nb"');
  });
});
