import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createToolRuntime } from '../src/runtime/index.js';
import {
  cleanupTempDirs,
  rawManifest,
  rawToolSource,
  relativeSpecifier,
  repoRoot,
  tempDir,
  writeRawPackage,
} from './runtime-helpers.js';

afterAll(async () => {
  await cleanupTempDirs();
});

describe('long-running use', () => {
  it('runs 200 sequential calls, keeps the process alive and leaves no global state', async () => {
    const dir = await tempDir('z1-e2e-200-');
    const manifest = rawManifest({ name: 'tool.loop' });
    await writeRawPackage(
      dir,
      rawToolSource(
        manifest,
        `(async () => {
          if (args.mode === 'set') { globalThis.leak = 'set'; return { leak: typeof globalThis.leak }; }
          if (args.mode === 'check') return { leak: typeof globalThis.leak };
          return { n: args.n };
        })()`,
      ),
      manifest,
    );
    const workspace = await tempDir('z1-e2e-200-work-');
    const runtime = await createToolRuntime({ workspace, maxOutputBytes: 64 * 1024 });

    const set = await runtime.run(dir, { mode: 'set' });
    expect(set.value).toEqual({ leak: 'string' });
    const check = await runtime.run(dir, { mode: 'check' });
    expect(check.value).toEqual({ leak: 'undefined' });

    const before = process.memoryUsage().rss;
    for (let index = 0; index < 200; index += 1) {
      const result = await runtime.run(dir, { n: index });
      expect(result.value).toEqual({ n: index });
    }
    const grown = process.memoryUsage().rss - before;
    expect(Number.isFinite(grown)).toBe(true);
    expect(grown).toBeLessThan(512 * 1024 * 1024);
  }, 60_000);
});

describe('z1-tool run', () => {
  it('prints the JSON value of a built tool and passes --args / --workspace', async () => {
    const project = await tempDir('z1-e2e-cli-');
    const source = await readFile(join(repoRoot, 'examples', 'find-todos', 'tool.ts'), 'utf8');
    const sdk = relativeSpecifier(project, join(repoRoot, 'src', 'index.ts'));
    const zod = relativeSpecifier(project, join(repoRoot, 'node_modules', 'zod', 'index.js'));
    await writeFile(
      join(project, 'tool.ts'),
      source.replace("from 'z1-tool-sdk'", `from '${sdk}'`).replace("from 'zod'", `from '${zod}'`),
      'utf8',
    );

    const build = await runCli(['build', project]);
    expect(build.code, build.stderr).toBe(0);

    const workspace = await tempDir('z1-e2e-cli-work-');
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'src', 'a.ts'), '// TODO: later\n', 'utf8');
    await writeFile(join(workspace, 'b.txt'), 'nothing to see\n', 'utf8');

    const run = await runCli([
      'run',
      project,
      '--args',
      '{"glob":"**/*"}',
      '--workspace',
      workspace,
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout.trim())).toEqual({
      matches: [{ path: 'src/a.ts', line: 1, text: '// TODO: later' }],
      count: 1,
    });

    const help = await runCli(['run', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('z1-tool run <dir>');
  }, 60_000);

  it('prints a one-line error with the runtime code and exits 1', async () => {
    const project = await tempDir('z1-e2e-cli-deny-');
    const sdk = relativeSpecifier(project, join(repoRoot, 'src', 'index.ts'));
    const zod = relativeSpecifier(project, join(repoRoot, 'node_modules', 'zod', 'index.js'));
    await writeFile(
      join(project, 'tool.ts'),
      `import { defineTool } from '${sdk}';
import { z } from '${zod}';

export const tool = defineTool({
  name: 'tool.denied',
  version: '0.1.0',
  description: 'Reads a file it was never granted.',
  parameters: z.object({}),
  capabilities: {},
  run: async (ctx) => ({ text: await ctx.fs.read('a.txt') }),
});
`,
      'utf8',
    );
    const build = await runCli(['build', project]);
    expect(build.code, build.stderr).toBe(0);

    const workspace = await tempDir('z1-e2e-cli-deny-work-');
    await writeFile(join(workspace, 'a.txt'), 'alpha', 'utf8');

    const denied = await runCli(['run', project, '--workspace', workspace]);
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain('capability_denied');
    expect(denied.stdout).toBe('');

    const badJson = await runCli(['run', project, '--args', '{nope']);
    expect(badJson.code).toBe(1);
    expect(badJson.stderr).toContain('--args must be valid JSON');

    const missing = await runCli(['run', join(workspace, 'nope')]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('invalid_tool');
  }, 60_000);
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd = repoRoot): Promise<CliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(repoRoot, 'src', 'cli.ts'), ...args], {
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
