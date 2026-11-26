import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTool, createTestContext, runTool } from '../src/index.js';
import type { AnyToolDefinition, ToolManifest } from '../src/index.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'src', 'cli.ts');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempDir(prefix = 'z1-tool-sdk-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function relativeSpecifier(fromDir: string, targetFile: string): string {
  const rel = relative(fromDir, targetFile).split('\\').join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

describe('buildTool', () => {
  it('builds the find-todos example, writes tool.json and never runs the tool', async () => {
    const out = await tempDir('z1-build-example-');
    const result = await buildTool({
      entry: join(repoRoot, 'examples', 'find-todos', 'tool.ts'),
      outDir: join(out, 'dist'),
    });

    expect(result.manifest.name).toBe('tool.find-todos');
    expect(result.manifest.capabilities.fs).toEqual({ read: ['**/*'], write: [] });
    expect(result.manifest.capabilities.limits).toEqual({
      timeoutMs: 10_000,
      maxOutputBytes: 262_144,
    });
    // A tool that declares neither gets the empty defaults, in the manifest too.
    expect(result.manifest.capabilities.net).toEqual({ hosts: [] });
    expect(result.manifest.capabilities.env).toEqual({ read: [] });

    const onDisk = JSON.parse(await readFile(result.manifestPath, 'utf8')) as ToolManifest;
    expect(onDisk).toEqual(result.manifest);
    expect((await stat(result.bundlePath)).isFile()).toBe(true);

    const module = (await import(`${pathToFileURL(result.bundlePath).href}?t=${Date.now()}`)) as {
      tool?: AnyToolDefinition;
    };
    expect(module.tool).toBeDefined();
    expect(typeof module.tool?.run).toBe('function');
    expect(module.tool?.manifest).toEqual(result.manifest);

    const ctx = createTestContext({
      workspace: '/work',
      files: { 'src/a.ts': '// TODO: later\nconst a = 1;\n' },
    });
    const output = await runTool(module.tool as AnyToolDefinition, {}, ctx);
    expect(output).toEqual({
      matches: [{ path: 'src/a.ts', line: 1, text: '// TODO: later' }],
      count: 1,
    });
  });

  it('does not call run while bundling', async () => {
    const dir = await tempDir('z1-build-fixture-');
    const sdkSpec = relativeSpecifier(dir, join(repoRoot, 'src', 'index.ts'));
    const zodSpec = relativeSpecifier(dir, join(repoRoot, 'node_modules', 'zod', 'index.js'));
    const entry = join(dir, 'tool.ts');
    await writeFile(
      entry,
      `import { defineTool } from '${sdkSpec}';
import { z } from '${zodSpec}';

const marker = '__z1ToolSdkRunMarker';

export const tool = defineTool({
  name: 'tool.build-fixture',
  version: '0.1.0',
  description: 'Build fixture that records whether run was called.',
  parameters: z.object({}),
  capabilities: {},
  run: async () => {
    (globalThis as Record<string, unknown>)[marker] = true;
    return { ok: true };
  },
});
`,
      'utf8',
    );

    const result = await buildTool({ entry, outDir: join(dir, 'dist') });
    expect(result.manifest.name).toBe('tool.build-fixture');
    expect((globalThis as Record<string, unknown>).__z1ToolSdkRunMarker).toBeUndefined();

    const module = (await import(`${pathToFileURL(result.bundlePath).href}?t=${Date.now()}`)) as {
      tool?: AnyToolDefinition;
    };
    await runTool(module.tool as AnyToolDefinition, {}, createTestContext());
    expect((globalThis as Record<string, unknown>).__z1ToolSdkRunMarker).toBe(true);
    delete (globalThis as Record<string, unknown>).__z1ToolSdkRunMarker;
  });

  it('normalises net and env declarations and writes them to tool.json', async () => {
    const dir = await tempDir('z1-build-net-');
    const sdkSpec = relativeSpecifier(dir, join(repoRoot, 'src', 'index.ts'));
    const zodSpec = relativeSpecifier(dir, join(repoRoot, 'node_modules', 'zod', 'index.js'));
    const entry = join(dir, 'tool.ts');
    await writeFile(
      entry,
      `import { defineTool } from '${sdkSpec}';
import { z } from '${zodSpec}';

export const tool = defineTool({
  name: 'tool.net-declared',
  version: '0.1.0',
  description: 'Declares network access and an env allow-list.',
  parameters: z.object({}),
  capabilities: {
    net: { hosts: ['b.example.com', '*', 'a.example.com'] },
    env: { read: ['EXA_API_KEY', 'HOME', 'EXA_API_KEY'] },
  },
  run: async () => ({ ok: true }),
});
`,
      'utf8',
    );

    const result = await buildTool({ entry, outDir: join(dir, 'dist') });
    // Sorted and de-duplicated like every other capability list. `'*'` sorts
    // first, so a manifest that allows any host is visible at the top.
    expect(result.manifest.capabilities.net).toEqual({
      hosts: ['*', 'a.example.com', 'b.example.com'],
    });
    expect(result.manifest.capabilities.env).toEqual({ read: ['EXA_API_KEY', 'HOME'] });

    const onDisk = JSON.parse(await readFile(result.manifestPath, 'utf8')) as ToolManifest;
    expect(onDisk.capabilities.net).toEqual({ hosts: ['*', 'a.example.com', 'b.example.com'] });
    expect(onDisk.capabilities.env).toEqual({ read: ['EXA_API_KEY', 'HOME'] });
  });

  it('keeps node:fs, node:child_process and node:net out of the library entry graph', async () => {
    const files = [
      'index.ts',
      'types.ts',
      'define.ts',
      'schema.ts',
      'context.ts',
      'testing.ts',
      'build.ts',
    ];
    const staticBuiltinImport =
      /import\s[^;]*?\sfrom\s*['"]node:(?:fs|child_process|net)(?:\/[^'"]*)?['"]/;

    for (const file of files) {
      const source = await readFile(join(repoRoot, 'src', file), 'utf8');
      expect(source, `${file} has a static node builtin import`).not.toMatch(staticBuiltinImport);
    }
  });
});

describe('z1-tool CLI', () => {
  it('initializes, builds, smoke-tests and packs a tool', async () => {
    const root = await tempDir('z1-cli-');
    const project = join(root, 'sample-tool');

    const init = await runCli(['init', 'sample-tool', project]);
    expect(init.code, init.stderr).toBe(0);
    expect(init.stdout).toContain('created sample-tool');

    const toolFile = await readFile(join(project, 'tool.ts'), 'utf8');
    expect(toolFile).toContain("import { defineTool } from 'z1-tool-sdk'");
    expect(JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))).toMatchObject({
      name: 'sample-tool',
      type: 'module',
    });

    // The temp project has no installed SDK; point imports at this checkout.
    const sdkSpec = relativeSpecifier(project, join(repoRoot, 'src', 'index.ts'));
    const zodSpec = relativeSpecifier(project, join(repoRoot, 'node_modules', 'zod', 'index.js'));
    await writeFile(
      join(project, 'tool.ts'),
      toolFile
        .replace("from 'z1-tool-sdk'", `from '${sdkSpec}'`)
        .replace("from 'zod'", `from '${zodSpec}'`),
      'utf8',
    );

    const build = await runCli(['build', project]);
    expect(build.code, build.stderr).toBe(0);
    expect(build.stdout).toContain('built sample-tool@0.1.0');
    const manifest = JSON.parse(
      await readFile(join(project, 'dist', 'tool.json'), 'utf8'),
    ) as ToolManifest;
    expect(manifest.name).toBe('sample-tool');
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.capabilities.limits.timeoutMs).toBe(30_000);
    expect((await stat(join(project, 'dist', 'index.js'))).isFile()).toBe(true);

    const smoke = await runCli(['test', project]);
    expect(smoke.code, smoke.stderr).toBe(0);
    expect(smoke.stdout).toContain('smoke check passed for sample-tool@0.1.0');

    const pack = await runCli(['pack', project]);
    expect(pack.code, pack.stderr).toBe(0);
    const match = /^packed (.+) sha256 ([0-9a-f]{64})$/m.exec(pack.stdout);
    expect(match).not.toBeNull();
    const archivePath = match?.[1] ?? '';
    const archive = await readFile(archivePath);
    expect(createHash('sha256').update(archive).digest('hex')).toBe(match?.[2] ?? '');
    expect(listTarEntries(gunzipSync(archive))).toEqual([
      'tool.json',
      'dist/index.js',
      'package.json',
      'LICENSE',
    ]);
  });

  it('prints help and exits non-zero on failure', async () => {
    const help = await runCli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('z1-tool - author');

    const empty = await tempDir('z1-cli-empty-');
    const missing = await runCli(['build', empty]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('missing tool.ts');

    const badName = await runCli(['init', 'Bad Name', join(empty, 'bad')]);
    expect(badName.code).not.toBe(0);
    expect(badName.stderr).toContain('z1-tool:');
  });

  it('runs a local vitest when it is installed', async () => {
    const project = await tempDir('z1-cli-vitest-');
    await writeFile(join(project, 'tool.ts'), 'export const tool = {};\n', 'utf8');
    await mkdir(join(project, 'node_modules', 'vitest'), { recursive: true });
    const vitestStub = join(project, 'node_modules', 'vitest', 'vitest.mjs');
    await writeFile(vitestStub, "console.log('fake vitest ran');\n", 'utf8');

    const passed = await runCli(['test', project]);
    expect(passed.code, passed.stderr).toBe(0);
    expect(passed.stdout).toContain('fake vitest ran');
    expect(passed.stdout).toContain('tests passed (vitest)');

    await writeFile(vitestStub, "console.error('fake failure');\nprocess.exit(2);\n", 'utf8');
    const failed = await runCli(['test', project]);
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('vitest exited with code 2');
  });

  it('finds a hoisted vitest install', async () => {
    const root = await tempDir('z1-cli-hoist-');
    const project = join(root, 'project');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'tool.ts'), 'export const tool = {};\n', 'utf8');
    const hoisted = join(root, 'node_modules', 'vitest');
    await mkdir(hoisted, { recursive: true });
    await writeFile(
      join(hoisted, 'package.json'),
      JSON.stringify({
        name: 'vitest',
        version: '0.0.0',
        bin: { vitest: './vitest.mjs' },
        exports: { './package.json': './package.json' },
      }),
      'utf8',
    );
    await writeFile(join(hoisted, 'vitest.mjs'), "console.log('hoisted vitest ran');\n", 'utf8');

    const result = await runCli(['test', project]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('hoisted vitest ran');
    expect(result.stdout).toContain('tests passed (vitest)');
  });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd = repoRoot): Promise<CliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cliPath, ...args], {
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

function listTarEntries(tar: Buffer): string[] {
  const names: string[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText, 8) || 0;
    names.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}
