import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProcessRunResult } from '../src/index.js';
import { createToolRuntime } from '../src/runtime/index.js';
import {
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

interface ProcessFixture {
  dir: string;
  runtime: Awaited<ReturnType<typeof createToolRuntime>>;
  workspace: string;
}

async function processFixture(
  runBody: string,
  options: {
    argv?: string[];
    process?: {
      timeoutMs?: number;
      maxOutputBytes?: number;
      env?: Record<string, string>;
      inheritEnv?: boolean;
    };
  } = {},
): Promise<ProcessFixture> {
  const dir = await tempDir('z1-process-');
  const manifest = rawManifest({ name: 'tool.process', argv: options.argv ?? ['node'] });
  await writeRawPackage(dir, rawToolSource(manifest, runBody), manifest);
  const workspace = await tempDir('z1-process-work-');
  const runtime = await createToolRuntime({
    workspace,
    ...(options.process === undefined ? {} : { process: options.process }),
  });
  return { dir, runtime, workspace };
}

/** A fixture body that runs `node -e <source>` in argv form. No shell involved. */
function runNode(source: string, extra = ''): string {
  const argv = JSON.stringify(['node', '-e', source]);
  return `(await ctx.process.run({ argv: ${argv}${extra} }))`;
}

describe('process.run', () => {
  it('runs a granted executable in argv form and returns its output', async () => {
    const tools = await processFixture(runNode('console.log("hi")'));
    const result = (await tools.runtime.run(tools.dir, {})).value as unknown as ProcessRunResult;
    expect(result).toEqual({ code: 0, stdout: 'hi\n', stderr: '' });
  });

  it('refuses an executable that is not granted', async () => {
    const tools = await processFixture(`(await ctx.process.run({ argv: ['whoami'] }))`, {
      argv: ['node'],
    });
    const error = await expectRuntimeError(
      () => tools.runtime.run(tools.dir, {}),
      'process_argv_denied',
    );
    expect(error.message).toContain('whoami');
  });

  it('treats a non-zero exit code as a result, not an error', async () => {
    const tools = await processFixture(runNode('process.exit(3)'));
    const result = (await tools.runtime.run(tools.dir, {})).value as unknown as ProcessRunResult;
    expect(result.code).toBe(3);
    expect(result.stdout).toBe('');
  });

  it('kills a child that runs past process.timeoutMs and reports process_timeout', async () => {
    const tools = await processFixture(
      runNode(
        "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'late'), 3000)",
        ", cwd: '.'",
      ),
      { process: { timeoutMs: 300 } },
    );
    const marker = join(tools.workspace, 'late.txt');

    const started = Date.now();
    const error = await expectRuntimeError(
      () => tools.runtime.run(tools.dir, {}),
      'process_timeout',
    );
    expect(error.message).toContain('time budget');
    expect(Date.now() - started).toBeLessThan(3000);

    await new Promise((resolve) => setTimeout(resolve, 1200));
    await expect(stat(marker)).rejects.toThrow(/ENOENT/);
  });

  it('refuses stdout over the process cap without crashing', async () => {
    const tools = await processFixture(runNode('process.stdout.write("y".repeat(30000))'), {
      process: { maxOutputBytes: 10_000 },
    });
    const error = await expectRuntimeError(
      () => tools.runtime.run(tools.dir, {}),
      'output_too_large',
    );
    expect(error.message).toContain('10000');
  });

  it('maps a buffered-output overflow (ENOBUFS) to output_too_large', async () => {
    const tools = await processFixture(runNode('process.stdout.write("z".repeat(300000))'), {
      process: { maxOutputBytes: 10_000 },
    });
    await expectRuntimeError(() => tools.runtime.run(tools.dir, {}), 'output_too_large');
  });

  it('refuses a cwd outside the workspace', async () => {
    const tools = await processFixture(runNode('1', ", cwd: '../outside'"));
    const error = await expectRuntimeError(
      () => tools.runtime.run(tools.dir, {}),
      'path_outside_workspace',
    );
    expect(error.message).toContain('..');
  });

  it('runs in a granted subdirectory of the workspace', async () => {
    const tools = await processFixture(runNode('console.log(process.cwd())', ", cwd: 'sub'"));
    await mkdir(join(tools.workspace, 'sub'), { recursive: true });

    const result = (await tools.runtime.run(tools.dir, {})).value as unknown as ProcessRunResult;
    expect(result.code).toBe(0);
    expect(result.stdout.trim().toLowerCase()).toBe(join(tools.workspace, 'sub').toLowerCase());
  });

  it('refuses environment overrides that could hijack the child', async () => {
    const tools = await processFixture(
      runNode('1', ", env: { NODE_OPTIONS: '--require ./x.js' }"),
    );
    const error = await expectRuntimeError(
      () => tools.runtime.run(tools.dir, {}),
      'process_argv_denied',
    );
    expect(error.message).toContain('NODE_OPTIONS');
  });

  it('reports a missing executable as process_failed with the name only', async () => {
    const tools = await processFixture(
      `(await ctx.process.run({ argv: ['node-does-not-exist-xyz'] }))`,
      { argv: ['node-does-not-exist-xyz'] },
    );
    const error = await expectRuntimeError(() => tools.runtime.run(tools.dir, {}), 'process_failed');
    expect(error.message).toContain('node-does-not-exist-xyz');
  });
});

describe('child environment (M2)', () => {
  const CANARY = 'Z1_CANARY_ENV';

  it('does not inherit the host environment unless asked', async () => {
    process.env[CANARY] = 'canary-secret';
    try {
      const tools = await processFixture(
        runNode(
          `console.log(JSON.stringify({ canary: process.env.Z1_CANARY_ENV === undefined ? 'absent' : 'visible', path: process.env.PATH === undefined ? 'absent' : 'visible' }))`,
        ),
      );
      const result = (await tools.runtime.run(tools.dir, {})).value as unknown as ProcessRunResult;
      expect(JSON.parse(result.stdout)).toEqual({ canary: 'absent', path: 'visible' });
    } finally {
      delete process.env[CANARY];
    }
  });

  it('inherits the host environment with inheritEnv: true', async () => {
    process.env[CANARY] = 'canary-secret';
    try {
      const tools = await processFixture(
        runNode(
          `console.log(process.env.Z1_CANARY_ENV === undefined ? 'absent' : 'visible')`,
        ),
        { process: { inheritEnv: true } },
      );
      const result = (await tools.runtime.run(tools.dir, {})).value as unknown as ProcessRunResult;
      expect(result.stdout.trim()).toBe('visible');
    } finally {
      delete process.env[CANARY];
    }
  });

  it('uses an explicit host env instead of the allow-list', async () => {
    process.env[CANARY] = 'canary-secret';
    try {
      const tools = await processFixture(
        runNode(
          `console.log(JSON.stringify({ canary: process.env.Z1_CANARY_ENV === undefined ? 'absent' : 'visible', custom: process.env.Z1_CUSTOM === undefined ? 'absent' : process.env.Z1_CUSTOM }))`,
        ),
        { process: { env: { PATH: process.env.PATH ?? '', Z1_CUSTOM: 'from-host' } } },
      );
      const result = (await tools.runtime.run(tools.dir, {})).value as unknown as ProcessRunResult;
      expect(JSON.parse(result.stdout)).toEqual({ canary: 'absent', custom: 'from-host' });
    } finally {
      delete process.env[CANARY];
    }
  });

  it('merges the tool env on top of the host env', async () => {
    const tools = await processFixture(
      runNode(
        `console.log(process.env.Z1_CUSTOM === undefined ? 'absent' : process.env.Z1_CUSTOM)`,
        ", env: { Z1_CUSTOM: 'from-tool' }",
      ),
      { process: { env: { PATH: process.env.PATH ?? '', Z1_CUSTOM: 'from-host' } } },
    );
    const result = (await tools.runtime.run(tools.dir, {})).value as unknown as ProcessRunResult;
    expect(result.stdout.trim()).toBe('from-tool');
  });
});
