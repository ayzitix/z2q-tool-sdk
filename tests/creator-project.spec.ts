import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ToolCreatorError } from '../src/creator/prompt.js';
import {
  createToolProject,
  placeholderToolSource,
  scaffoldToolProject,
} from '../src/creator/project.js';
import { reviewToolSource } from '../src/creator/review.js';
import { smokeTestTool } from '../src/creator/smoke.js';
import type { ToolManifest } from '../src/index.js';
import { cleanupTempDirs, tempDir } from './runtime-helpers.js';

afterAll(async () => {
  await cleanupTempDirs();
});

const PURPOSE = 'Read a workspace file and return its length in characters.';

function projectSource(name: string): string {
  return `import { defineTool } from 'z1-tool-sdk';
import { z } from 'zod';

export const tool = defineTool({
  name: '${name}',
  version: '0.1.0',
  description: 'Read a workspace file and return its length in characters.',
  parameters: z.object({ path: z.string() }),
  capabilities: { fs: { read: ['**/*'] } },
  run: async (ctx, args) => {
    const text = await ctx.fs.read(args.path);
    return { length: text.length };
  },
});
`;
}

async function rejection(promise: Promise<unknown>): Promise<ToolCreatorError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolCreatorError);
    return error as ToolCreatorError;
  }
  throw new Error('expected the call to reject, but it resolved');
}

async function exists(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  return info !== undefined;
}

describe('createToolProject', () => {
  it('writes the six files, builds the entry and matches the manifest', async () => {
    const base = await tempDir('z1-creator-project-');
    const dir = join(base, 'tool.sample');
    const request = { name: 'tool.sample', purpose: PURPOSE };

    const result = await createToolProject({ dir, request, source: projectSource('tool.sample') });

    expect(result.dir).toBe(dir);
    expect(result.entry).toBe(join(dir, 'tool.ts'));
    expect(result.report.ok).toBe(true);
    expect(result.report.name).toBe('tool.sample');
    expect(result.report.capabilities?.fs.read).toEqual(['**/*']);

    const entries = (await readdir(dir)).filter((entry) => entry !== 'dist');
    expect(entries.sort()).toEqual([
      '.gitignore',
      'README.md',
      'package.json',
      'tool.test.ts',
      'tool.ts',
      'tsconfig.json',
    ]);

    const manifest = JSON.parse(
      await readFile(join(dir, 'dist', 'tool.json'), 'utf8'),
    ) as ToolManifest;
    expect(manifest).toEqual(result.manifest);
    expect(manifest.name).toBe('tool.sample');
    expect(manifest.capabilities.fs.read).toEqual(['**/*']);

    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    expect(pkg).toMatchObject({ name: 'tool.sample', version: '0.1.0' });
    expect(await readFile(join(dir, 'tool.test.ts'), 'utf8')).toContain("describe('tool.sample'");
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toContain(PURPOSE);
  });

  it('refuses a second project in an existing non-empty directory', async () => {
    const base = await tempDir('z1-creator-project-again-');
    const dir = join(base, 'tool.sample');
    const request = { name: 'tool.sample', purpose: PURPOSE };
    await createToolProject({ dir, request, source: projectSource('tool.sample') });

    const error = await rejection(
      createToolProject({ dir, request, source: projectSource('tool.sample') }),
    );

    expect(error.code).toBe('project_not_empty');
    expect(await readFile(join(dir, 'tool.ts'), 'utf8')).toBe(projectSource('tool.sample'));
  });

  it('refuses a source that fails static review before writing anything', async () => {
    const base = await tempDir('z1-creator-project-refuse-');
    const dir = join(base, 'never');
    const bad = projectSource('tool.sample').replace(
      "    const text = await ctx.fs.read(args.path);",
      '    const text = String(process.env.HOME);',
    );

    const error = await rejection(
      createToolProject({ dir, request: { name: 'tool.sample', purpose: PURPOSE }, source: bad }),
    );

    expect(error.code).toBe('invalid_source');
    expect(error.report?.issues[0]?.code).toBe('forbidden_identifier');
    expect(await exists(dir)).toBe(false);
  });

  it('refuses a source that declares another tool name, before writing', async () => {
    const base = await tempDir('z1-creator-project-name-');
    const dir = join(base, 'mismatch');

    const error = await rejection(
      createToolProject({
        dir,
        request: { name: 'tool.sample', purpose: PURPOSE },
        source: projectSource('tool.other'),
      }),
    );

    expect(error.code).toBe('name_mismatch');
    expect(await exists(dir)).toBe(false);
  });
});

describe('smokeTestTool', () => {
  function smokeSource(name: string, capabilities: string, run: string): string {
    return `import { defineTool } from 'z1-tool-sdk';
import { z } from 'zod';

export const tool = defineTool({
  name: '${name}',
  version: '0.1.0',
  description: 'A smoke-test fixture that returns a small JSON value.',
  parameters: z.object({ path: z.string().default('a.txt') }),
  capabilities: ${capabilities},
  run: ${run},
});
`;
  }

  it('runs request.examples in the sandbox and returns the JSON value', async () => {
    const dir = await tempDir('z1-creator-smoke-ok-');
    const workspace = await tempDir('z1-creator-smoke-ok-work-');
    await writeFile(join(workspace, 'a.txt'), 'hello\nworld\n', 'utf8');
    await writeFile(
      join(dir, 'tool.ts'),
      smokeSource(
        'tool.smoke-ok',
        "{ fs: { read: ['**/*'] } }",
        'async (ctx, args) => { const text = await ctx.fs.read(args.path); return { path: args.path, length: text.length }; }',
      ),
      'utf8',
    );

    const result = await smokeTestTool(dir, {
      workspace,
      request: {
        name: 'tool.smoke-ok',
        purpose: 'A smoke-test fixture.',
        examples: [{ input: { path: 'a.txt' } }],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      ok: true,
      value: { path: 'a.txt', length: 12 },
    });
    expect(result.runs[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports tool_threw and defaults to one run with {}', async () => {
    const dir = await tempDir('z1-creator-smoke-throw-');
    const workspace = await tempDir('z1-creator-smoke-throw-work-');
    await writeFile(
      join(dir, 'tool.ts'),
      smokeSource(
        'tool.smoke-throws',
        '{}',
        "async () => { throw new Error('boom'); }",
      ),
      'utf8',
    );

    const result = await smokeTestTool(dir, { workspace });

    expect(result.ok).toBe(false);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ ok: false, code: 'tool_threw' });
  });

  it('reports path_outside_workspace for a parent path', async () => {
    const dir = await tempDir('z1-creator-smoke-outside-');
    const workspace = await tempDir('z1-creator-smoke-outside-work-');
    await writeFile(
      join(dir, 'tool.ts'),
      smokeSource(
        'tool.smoke-outside',
        "{ fs: { read: ['**/*'] } }",
        "async (ctx) => ({ text: await ctx.fs.read('../secret.txt') })",
      ),
      'utf8',
    );

    const result = await smokeTestTool(dir, { workspace });

    expect(result.ok).toBe(false);
    expect(result.runs[0]).toMatchObject({ ok: false, code: 'path_outside_workspace' });
  });

  it('reports a caught denial instead of accepting the tool value', async () => {
    const dir = await tempDir('z1-creator-smoke-denied-');
    const workspace = await tempDir('z1-creator-smoke-denied-work-');
    await writeFile(
      join(dir, 'tool.ts'),
      smokeSource(
        'tool.smoke-denied',
        '{}',
        "async (ctx) => { try { await ctx.process.run({ argv: ['cmd'] }); } catch {} return { ok: true }; }",
      ),
      'utf8',
    );

    const denied = await smokeTestTool(dir, { workspace });
    expect(denied.ok).toBe(false);
    expect(denied.runs[0]?.ok).toBe(false);
    expect(denied.runs[0]?.denied).toBeGreaterThan(0);
    expect(denied.runs[0]?.codes.length).toBeGreaterThan(0);
    expect(denied.runs[0]?.value).toEqual({ ok: true });

    const allowed = await smokeTestTool(dir, { workspace, allowDenials: true });
    expect(allowed.ok).toBe(true);
    expect(allowed.runs[0]).toMatchObject({ ok: true, value: { ok: true } });
    expect(allowed.runs[0]?.denied).toBeGreaterThan(0);
  });

  it('reports process_failed for an absent binary without hanging', async () => {
    const dir = await tempDir('z1-creator-smoke-process-');
    const workspace = await tempDir('z1-creator-smoke-process-work-');
    const binary = 'z1-sdk-absent-binary-xyz';
    await writeFile(
      join(dir, 'tool.ts'),
      smokeSource(
        'tool.smoke-process',
        `{ process: { argv: ['${binary}'] } }`,
        `async (ctx) => { const r = await ctx.process.run({ argv: ['${binary}'] }); return { code: r.code }; }`,
      ),
      'utf8',
    );

    const started = Date.now();
    const result = await smokeTestTool(dir, { workspace, timeoutMs: 5000 });
    const elapsed = Date.now() - started;

    expect(result.runs[0]).toMatchObject({ ok: false, code: 'process_failed' });
    expect(elapsed).toBeLessThan(15_000);
  });
});

describe('scaffoldToolProject', () => {
  it('writes the six files, no dist, and the placeholder itself passes review', async () => {
    const base = await tempDir('z1-creator-scaffold-');
    const dir = join(base, 'tool.skeleton');
    const request = { name: 'tool.skeleton', purpose: PURPOSE };
    const source = placeholderToolSource(request);

    expect(reviewToolSource(source).ok).toBe(true);

    const scaffold = await scaffoldToolProject({ dir, request, source });

    expect(scaffold.files).toHaveLength(6);
    expect((await readdir(dir)).sort()).toEqual([
      '.gitignore',
      'README.md',
      'package.json',
      'tool.test.ts',
      'tool.ts',
      'tsconfig.json',
    ]);
    expect(await exists(join(dir, 'dist'))).toBe(false);
    expect(await readFile(join(dir, 'tool.ts'), 'utf8')).toBe(source);
  });

  it('refuses to write a project through a junction at the project path', async () => {
    const fs = await import('node:fs/promises');
    const base = await tempDir('z1-project-link-');
    const outside = join(base, 'outside');
    const linked = join(base, 'linked');
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, linked, 'junction');

    const source = projectSource('tool.linked');
    await expect(
      createToolProject({
        dir: linked,
        request: { name: 'tool.linked', purpose: PURPOSE },
        source,
      }),
    ).rejects.toThrow(ToolCreatorError);
    expect(await fs.readdir(outside)).toEqual([]);
  });
});
