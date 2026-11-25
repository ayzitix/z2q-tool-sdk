import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildTool } from '../src/index.js';
import type { Json } from '../src/index.js';
import {
  createMemoryAuditSink,
  createToolRuntime,
  loadToolPackage,
} from '../src/runtime/index.js';
import {
  buildToolFixture,
  cleanupTempDirs,
  expectRuntimeError,
  rawManifest,
  rawToolSource,
  tempDir,
  writeRawPackage,
} from './runtime-helpers.js';

afterAll(async () => {
  await cleanupTempDirs();
});

const PROBE_SOURCE = `import { defineTool } from '__SDK__';
import { z } from '__ZOD__';

export const tool = defineTool({
  name: 'tool.probe',
  version: '0.1.0',
  description: 'Probe tool for the runtime specs.',
  parameters: z.object({
    mode: z.string().default('ok'),
    path: z.string().default('a.txt'),
    count: z.number().int().min(0).default(0),
  }),
  capabilities: {
    fs: { read: ['**/*'], write: ['out/**'] },
    process: { argv: ['node'] },
    limits: { timeoutMs: 10_000, maxOutputBytes: 1_048_576 },
  },
  run: async (ctx, args) => {
    if (args.mode === 'ok') return { ok: true, count: args.count, workspace: ctx.workspace };
    if (args.mode === 'throw') throw new Error('boom');
    if (args.mode === 'read') return { text: await ctx.fs.read(args.path) };
    if (args.mode === 'keys') return { keys: Object.keys(globalThis) };
    return { mode: args.mode };
  },
});
`;

describe('sandboxed execution', () => {
  it('runs the find-todos example end to end through loadToolPackage', async () => {
    const out = await tempDir('z1-sandbox-example-');
    const built = await buildTool({
      entry: join(process.cwd(), 'examples', 'find-todos', 'tool.ts'),
      outDir: join(out, 'dist'),
    });
    const workspace = await tempDir('z1-sandbox-work-');
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'src', 'a.ts'), '// TODO: later\nconst a = 1;\n', 'utf8');
    await writeFile(join(workspace, 'b.txt'), 'FIXME: now\nnothing\n', 'utf8');
    await writeFile(join(workspace, 'c.txt'), 'no markers here\n', 'utf8');

    const pkg = await loadToolPackage(out);
    expect(pkg.manifest.name).toBe('tool.find-todos');
    expect(pkg.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pkg.dir).toBe(out);

    const runtime = await createToolRuntime({ workspace });
    const result = await runtime.run(pkg, {});
    expect(result.tool).toBe('tool.find-todos');
    expect(result.version).toBe('0.1.0');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.value).toEqual({
      matches: [
        { path: 'b.txt', line: 1, text: 'FIXME: now' },
        { path: 'src/a.ts', line: 1, text: '// TODO: later' },
      ],
      count: 2,
    });
    expect(built.manifest.capabilities.fs.read).toEqual(['**/*']);
  });

  it('exposes only the bridge and two globals, with no way back to Node', async () => {
    const dir = await tempDir('z1-sandbox-globals-');
    const manifest = rawManifest({ name: 'tool.globals' });
    await writeRawPackage(
      dir,
      rawToolSource(
        manifest,
        `({
          types: {
            process: typeof process,
            require: typeof require,
            fetch: typeof fetch,
            std: typeof std,
            os: typeof os,
            module: typeof module,
            exports: typeof exports,
            global: typeof global,
            Buffer: typeof Buffer,
          },
          keys: Object.keys(globalThis),
          bridge: typeof __z1_invoke,
          args: __z1_args,
          workspace: __z1_workspace,
        })`,
      ),
      manifest,
    );

    const workspace = await tempDir('z1-sandbox-globals-work-');
    const runtime = await createToolRuntime({ workspace });
    const result = (await runtime.run(dir, { a: 1 })).value as {
      types: Record<string, string>;
      keys: string[];
      bridge: string;
      args: string;
      workspace: string;
    };

    // A hand-written bundle is used on purpose: esbuild injects its own
    // `__require` shim into any bundle that mentions `require`, so a built tool
    // would report a function there regardless of the sandbox.
    for (const name of ['process', 'require', 'fetch', 'std', 'os', 'module', 'exports', 'global', 'Buffer']) {
      expect(result.types[name], `typeof ${name}`).toBe('undefined');
    }
    expect(result.bridge).toBe('function');
    expect(result.args).toBe('{"a":1}');
    expect(result.workspace).toBe(workspace);
    expect(result.keys).toEqual(
      expect.arrayContaining(['__z1_invoke', '__z1_args', '__z1_workspace', '__z1_ctx', '__z1_run']),
    );
    for (const forbidden of ['process', 'require', 'module', 'global', 'Buffer', 'fetch']) {
      expect(result.keys).not.toContain(forbidden);
    }
  });

  it('reports a throwing tool as tool_threw without a host stack', async () => {
    const fixture = await buildToolFixture(PROBE_SOURCE);
    const workspace = await tempDir('z1-sandbox-throw-');
    const runtime = await createToolRuntime({ workspace });

    const error = await expectRuntimeError(() => runtime.run(fixture, { mode: 'throw' }), 'tool_threw');
    expect(error.message).toContain('boom');
    expect(error.tool).toBe('tool.probe');
    expect(error.message).not.toMatch(/node:internal|sandbox\.ts|at async file:/);
  });

  it('rejects arguments that fail the zod schema and applies defaults', async () => {
    const fixture = await buildToolFixture(PROBE_SOURCE);
    const workspace = await tempDir('z1-sandbox-args-');
    const runtime = await createToolRuntime({ workspace });

    const error = await expectRuntimeError(
      () => runtime.run(fixture, { count: -1 }),
      'invalid_arguments',
    );
    expect(error.details).toEqual([
      { path: ['count'], message: expect.stringContaining('>=0') },
    ]);
    expect(error.message).toContain('count');

    const applied = await runtime.run(fixture, {});
    expect(applied.value).toEqual({ ok: true, count: 0, workspace });
  });

  it('keeps two runtimes over two workspaces apart', async () => {
    const first = await tempDir('z1-sandbox-first-');
    const second = await tempDir('z1-sandbox-second-');
    await writeFile(join(first, 'shared.txt'), 'first', 'utf8');
    await writeFile(join(second, 'shared.txt'), 'second', 'utf8');
    await writeFile(join(first, 'only-first.txt'), 'x', 'utf8');

    const dir = await tempDir('z1-sandbox-two-');
    const manifest = rawManifest({ name: 'tool.two', read: ['**/*'] });
    await writeRawPackage(
      dir,
      rawToolSource(
        manifest,
        `({
          shared: await ctx.fs.read('shared.txt'),
          names: (await ctx.fs.glob('**/*')).sort(),
        })`,
      ),
      manifest,
    );

    const runtimeA = await createToolRuntime({ workspace: first });
    const runtimeB = await createToolRuntime({ workspace: second });
    const a = await runtimeA.run(dir, {});
    const b = await runtimeB.run(dir, {});
    expect(a.value).toEqual({ shared: 'first', names: ['only-first.txt', 'shared.txt'] });
    expect(b.value).toEqual({ shared: 'second', names: ['shared.txt'] });
  });

  it('refuses a bundle that imports a Node builtin, naming it', async () => {
    const fixture = await buildToolFixture(`import { readFileSync } from 'node:fs';
import { defineTool } from '__SDK__';
import { z } from '__ZOD__';

export const tool = defineTool({
  name: 'tool.builtin',
  version: '0.1.0',
  description: 'Imports a Node builtin on purpose.',
  parameters: z.object({}),
  capabilities: {},
  run: async () => ({ length: readFileSync(new URL(import.meta.url)).length }),
});
`);
    expect(fixture.source).toContain('node:fs');

    const workspace = await tempDir('z1-sandbox-builtin-');
    const runtime = await createToolRuntime({ workspace });
    const error = await expectRuntimeError(() => runtime.run(fixture, {}), 'invalid_tool');
    expect(error.message).toContain('node:fs');
    expect(error.message).not.toContain('undefined');
  });

  it('records allow and deny rows for every bridged call', async () => {
    const fixture = await buildToolFixture(PROBE_SOURCE);
    const workspace = await tempDir('z1-sandbox-audit-');
    await writeFile(join(workspace, 'a.txt'), 'alpha', 'utf8');
    const sink = createMemoryAuditSink();
    const runtime = await createToolRuntime({ workspace, audit: sink });

    const result = await runtime.run(fixture, { mode: 'read', path: 'a.txt' });
    expect(result.value).toEqual({ text: 'alpha' });
    expect(result.audit.map((row) => [row.kind, row.decision, row.target])).toEqual([
      ['fs.read', 'allow', 'a.txt'],
    ]);

    await expectRuntimeError(() => runtime.run(fixture, { mode: 'read', path: '.env' }), 'secret_path_denied');
    await expectRuntimeError(() => runtime.run(fixture, { mode: 'read', path: '.git/config' }), 'path_denied');

    const denied = sink.rows.filter((row) => row.decision === 'deny');
    expect(denied.map((row) => [row.code, row.target])).toEqual([
      ['secret_path_denied', '<redacted>'],
      ['path_denied', '.git/config'],
    ]);
    expect(sink.rows.filter((row) => row.decision === 'allow')).toHaveLength(1);
    expect(JSON.stringify(sink.rows)).not.toContain('alpha');
  });

  it('accepts a raw ToolPackage without touching the disk for the bundle', async () => {
    const workspace = await tempDir('z1-sandbox-pkg-');
    const manifest = rawManifest({ name: 'tool.inline' });
    const runtime = await createToolRuntime({ workspace });
    const result = await runtime.run(
      {
        manifest,
        source: rawToolSource(manifest, `({ inline: true, args })`),
        sha256: 'deadbeef',
      },
      { hello: 'world' },
    );
    expect(result.value as Json).toEqual({ inline: true, args: { hello: 'world' } });
  });

  it('surfaces a missing package as invalid_tool', async () => {
    const workspace = await tempDir('z1-sandbox-missing-');
    const runtime = await createToolRuntime({ workspace });
    await expectRuntimeError(() => runtime.run(join(workspace, 'nope'), {}), 'invalid_tool');

    const dir = await tempDir('z1-sandbox-badjson-');
    await mkdir(join(dir, 'dist'), { recursive: true });
    await writeFile(join(dir, 'dist', 'tool.json'), '{not json', 'utf8');
    await writeFile(join(dir, 'dist', 'index.js'), 'export const tool = {};', 'utf8');
    await expectRuntimeError(() => runtime.run(dir, {}), 'invalid_tool');

    const huge = rawManifest({ name: 'tool.huge' });
    const bigDir = await tempDir('z1-sandbox-huge-');
    await writeRawPackage(bigDir, `export const tool = {};\n/*${'x'.repeat(9 * 1024 * 1024)}*/`, huge);
    await expectRuntimeError(() => runtime.run(bigDir, {}), 'invalid_tool');
  });
});

describe('granted listings and the hardened bridge', () => {
  it('lists the root and a granted directory through the same grant (S1, S2)', async () => {
    const dir = await tempDir('z1-sandbox-list-');
    const manifest = rawManifest({ name: 'tool.list', read: ['docs/**'] });
    await writeRawPackage(
      dir,
      rawToolSource(
        manifest,
        `({
          root: (await ctx.fs.list('')).map((entry) => entry.path),
          docs: (await ctx.fs.list('docs')).map((entry) => entry.path),
          text: await ctx.fs.read('docs/a.md'),
        })`,
      ),
      manifest,
    );
    const workspace = await tempDir('z1-sandbox-list-work-');
    await mkdir(join(workspace, 'docs'), { recursive: true });
    await writeFile(join(workspace, 'docs', 'a.md'), 'alpha', 'utf8');
    await writeFile(join(workspace, 'root.txt'), 'root', 'utf8');
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'src', 'b.ts'), 'b', 'utf8');

    const runtime = await createToolRuntime({ workspace });
    const result = await runtime.run(dir, {});
    expect(result.value).toEqual({ root: ['docs'], docs: ['docs/a.md'], text: 'alpha' });
  });

  it('refuses a junction that resolves onto .git (M3)', async () => {
    const dir = await tempDir('z1-sandbox-junction-');
    const manifest = rawManifest({ name: 'tool.junction', read: ['**/*'] });
    await writeRawPackage(
      dir,
      rawToolSource(
        manifest,
        `(async () => ({ text: await ctx.fs.read('repo/config') }))()`,
      ),
      manifest,
    );
    const workspace = await tempDir('z1-sandbox-junction-work-');
    await mkdir(join(workspace, '.git'), { recursive: true });
    await writeFile(join(workspace, '.git', 'config'), 'GIT_SECRET', 'utf8');
    await symlink(join(workspace, '.git'), join(workspace, 'repo'), 'junction');

    const runtime = await createToolRuntime({ workspace });
    const error = await expectRuntimeError(() => runtime.run(dir, {}), 'path_denied');
    expect(error.message).toContain('.git');
    expect(error.message).not.toContain('GIT_SECRET');
  });

  it('refuses __z1_invoke without arguments without leaking a host message (n1)', async () => {
    const dir = await tempDir('z1-sandbox-n1-');
    const manifest = rawManifest({ name: 'tool.n1' });
    await writeRawPackage(
      dir,
      rawToolSource(
        manifest,
        `(() => {
          try {
            __z1_invoke();
            return { ok: true, message: '' };
          } catch (error) {
            return { ok: false, message: String(error && error.message) };
          }
        })()`,
      ),
      manifest,
    );
    const workspace = await tempDir('z1-sandbox-n1-work-');
    const runtime = await createToolRuntime({ workspace });
    const value = (await runtime.run(dir, {})).value as { ok: boolean; message: string };
    expect(value.ok).toBe(false);
    expect(value.message).toMatch(/^invalid_arguments: __z1_invoke\(kind, payloadJson\)/);
    expect(value.message).not.toMatch(/owner|quickjs|sandbox|dist/);
  });

  it('refuses unknown fs.grep option keys instead of ignoring them (n3)', async () => {
    const dir = await tempDir('z1-sandbox-n3-');
    const manifest = rawManifest({ name: 'tool.n3', read: ['**/*'] });
    await writeRawPackage(
      dir,
      rawToolSource(
        manifest,
        `(async () => {
          try {
            await ctx.fs.grep('x', { path: '.git' });
            return { ok: true, message: '' };
          } catch (error) {
            return { ok: false, message: String(error && error.message) };
          }
        })()`,
      ),
      manifest,
    );
    const workspace = await tempDir('z1-sandbox-n3-work-');
    await writeFile(join(workspace, 'a.txt'), 'x', 'utf8');
    const runtime = await createToolRuntime({ workspace });
    const value = (await runtime.run(dir, {})).value as { ok: boolean; message: string };
    expect(value.ok).toBe(false);
    expect(value.message).toContain('invalid_arguments');
    expect(value.message).toContain('options.path');
    // A known option still works.
    const result = await runtime.run(
      {
        manifest,
        source: rawToolSource(
          manifest,
          `(await ctx.fs.grep('x', { glob: '**/*.txt', ignoreCase: true }))`,
        ),
        sha256: 'deadbeef',
      },
      {},
    );
    expect(result.value).toEqual([{ path: 'a.txt', line: 1, text: 'x' }]);
  });
});
