import { afterAll, describe, expect, it } from 'vitest';
import {
  SANDBOX_MAX_OUTPUT_BYTES,
  SANDBOX_MEMORY_BYTES,
  createToolRuntime,
} from '../src/runtime/index.js';
import type { ToolRuntime } from '../src/runtime/index.js';
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

/**
 * These fixtures are raw packages rather than zod bundles, so the limits are
 * measured without paying for a full bundle. The teardown abort that
 * quickjs-emscripten 0.32.0 throws for multi-megabyte strings is documented in
 * SECURITY.md; the bridge chunking keeps it away from ordinary calls.
 */
interface Fixture {
  dir: string;
  runtime: ToolRuntime;
  workspace: string;
}

async function fixture(
  runBody: string,
  options: { maxOutputBytes?: number; memoryBytes?: number; maxTimeoutMs?: number; limits?: { timeoutMs: number; maxOutputBytes: number } } = {},
): Promise<Fixture> {
  const dir = await tempDir('z1-limits-');
  const manifest = rawManifest({
    name: 'tool.limits',
    limits: options.limits ?? { timeoutMs: 10_000, maxOutputBytes: SANDBOX_MAX_OUTPUT_BYTES },
  });
  await writeRawPackage(dir, rawToolSource(manifest, runBody), manifest);
  const workspace = await tempDir('z1-limits-work-');
  const runtime = await createToolRuntime({
    workspace,
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    ...(options.memoryBytes === undefined ? {} : { memoryBytes: options.memoryBytes }),
    ...(options.maxTimeoutMs === undefined ? {} : { maxTimeoutMs: options.maxTimeoutMs }),
  });
  return { dir, runtime, workspace };
}

describe('loop and time limits', () => {
  it('stops a busy loop at the deadline and keeps working afterwards', async () => {
    const stuck = await fixture(`(() => { while (true) {} })()`);
    const result = await fixture(`({ ok: true })`);

    const started = Date.now();
    const error = await expectRuntimeError(
      () => stuck.runtime.run(stuck.dir, {}, { timeoutMs: 300 }),
      'time_limit',
    );
    const elapsed = Date.now() - started;
    expect(error.tool).toBe('tool.limits');
    expect(elapsed).toBeLessThan(300 + 1000);

    // Same ToolRuntime instance, same shared WASM module: it must still work.
    expect((await stuck.runtime.run(result.dir, {})).value).toEqual({ ok: true });
  });

  it('reports a promise that can never settle as loop_limit', async () => {
    const tools = await fixture(`(async () => { await new Promise(() => {}); return {}; })()`);
    await expectRuntimeError(
      () => tools.runtime.run(tools.dir, {}, { timeoutMs: 5000 }),
      'loop_limit',
    );
  });

  it('honours the host maxTimeoutMs ceiling over a greedy manifest', async () => {
    const tools = await fixture(`(() => { while (true) {} })()`, {
      maxTimeoutMs: 250,
      limits: { timeoutMs: 600_000, maxOutputBytes: SANDBOX_MAX_OUTPUT_BYTES },
    });

    const started = Date.now();
    await expectRuntimeError(() => tools.runtime.run(tools.dir, {}), 'time_limit');
    expect(Date.now() - started).toBeLessThan(250 + 1000);
  });

  it('honours an already-aborted signal before touching the VM', async () => {
    const tools = await fixture(`({ ok: true })`);
    const controller = new AbortController();
    controller.abort();
    const error = await expectRuntimeError(
      () => tools.runtime.run(tools.dir, {}, { signal: controller.signal }),
      'time_limit',
    );
    expect(error.message).toContain('aborted');
  });

  it('rejects an invalid timeoutMs instead of running unbounded', async () => {
    const tools = await fixture(`({ ok: true })`);
    await expectRuntimeError(
      () => tools.runtime.run(tools.dir, {}, { timeoutMs: 0 }),
      'invalid_arguments',
    );
  });
});

describe('memory limits', () => {
  it('stops a memory bomb with memory_limit and survives', async () => {
    const bomb = await fixture(`(() => { const text = 'x'.repeat(200 * 1024 * 1024); return { length: text.length }; })()`);
    const error = await expectRuntimeError(() => bomb.runtime.run(bomb.dir, {}), 'memory_limit');
    expect(error.message).toContain(String(SANDBOX_MEMORY_BYTES));

    const again = await fixture(`({ ok: true })`);
    expect((await bomb.runtime.run(again.dir, {})).value).toEqual({ ok: true });
  });
});

describe('output limits', () => {
  it.each([
    ['undefined', `undefined`, 'undefined'],
    ['a function', `({ run: function nope() {} })`, 'function'],
    ['a BigInt', `({ size: 1n })`, 'BigInt'],
    ['NaN', `({ size: NaN })`, 'non-finite'],
    ['Infinity', `({ size: Infinity })`, 'non-finite'],
    ['a cycle', `(() => { const o = {}; o.self = o; return o; })()`, 'JSON'],
  ])('rejects %s as invalid_output', async (_label, body, detail) => {
    const tools = await fixture(body);
    const error = await expectRuntimeError(
      () => tools.runtime.run(tools.dir, {}),
      'invalid_output',
    );
    expect(error.message.toLowerCase()).toContain(detail.toLowerCase());
  });

  it('rejects a result over the output cap and names the limit', async () => {
    const tools = await fixture(`({ data: 'x'.repeat(9 * 1024 * 1024) })`, {
      maxOutputBytes: SANDBOX_MAX_OUTPUT_BYTES,
    });
    const error = await expectRuntimeError(
      () => tools.runtime.run(tools.dir, {}),
      'output_too_large',
    );
    expect(error.message).toContain(String(SANDBOX_MAX_OUTPUT_BYTES));
  });

  it('applies the manifest output cap even when the host allows more', async () => {
    const tools = await fixture(`({ data: 'x'.repeat(4096) })`, {
      maxOutputBytes: 8 * 1024 * 1024,
      limits: { timeoutMs: 10_000, maxOutputBytes: 2048 },
    });
    const error = await expectRuntimeError(
      () => tools.runtime.run(tools.dir, {}),
      'output_too_large',
    );
    expect(error.message).toContain('2048');
  });

  it('refuses unserializable arguments before touching the VM', async () => {
    const tools = await fixture(`({ ok: true })`);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expectRuntimeError(() => tools.runtime.run(tools.dir, cyclic), 'invalid_arguments');
    await expectRuntimeError(
      () => tools.runtime.run(tools.dir, { big: 1n }),
      'invalid_arguments',
    );
  });
});

