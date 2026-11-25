import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule,
  Scope,
} from 'quickjs-emscripten';
import {
  SANDBOX_MAX_BRIDGE_BYTES,
  SANDBOX_MAX_BUNDLE_BYTES,
  SANDBOX_MAX_PUMP_ITERATIONS,
  SANDBOX_MAX_TIMEOUT_MS,
  SANDBOX_MEMORY_BYTES,
  SANDBOX_STACK_BYTES,
} from './limits.js';

/**
 * Read a built tool's manifest without ever importing its bundle on the host.
 *
 * This is the boundary `buildTool` relies on. The bundle's top level runs in a
 * fresh QuickJS runtime with no bridge: there is no `__z1_invoke`, no
 * `__z1_args`, no `console` passthrough and no host function of any kind. The
 * only value that leaves the VM is the manifest string, and it is capped before
 * it crosses.
 *
 * The module source is served by `setModuleLoader` for one fixed specifier.
 * Every other specifier is refused with a message that names the mistake: a
 * bundle that still contains a static import needs to be bundled completely.
 */

export interface DefinitionReadOptions {
  /** Wall-clock budget for the import and the manifest read. Default 5 000 ms. */
  timeoutMs?: number;
  /** QuickJS heap for this read. Default {@link SANDBOX_MEMORY_BYTES}. */
  memoryBytes?: number;
  /**
   * Largest manifest JSON accepted, in UTF-8 bytes. Default 1 MiB.
   *
   * The cap is enforced inside the VM before the string crosses the bridge.
   * Measured: a 1 291 164-byte manifest arrives intact but `runtime.dispose()`
   * then throws the documented QuickJS abort, so a larger cap is not safe.
   */
  maxManifestBytes?: number;
}

export interface DefinitionReadResult {
  readonly manifest: unknown;
}

type QuickJSModule = typeof import('quickjs-emscripten');

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_MANIFEST_BYTES = 1024 * 1024;
const MODULE_NAME = 'z1-tool-bundle.mjs';
const MAX_ERROR_MESSAGE = 4_096;

let modulePromise: Promise<QuickJSModule> | undefined;
let wasmPromise: Promise<QuickJSWASMModule> | undefined;

/** Lazy, shared QuickJS loader. The WASM module is created once per process. */
function loadQuickJS(): Promise<QuickJSModule> {
  modulePromise ??= import('quickjs-emscripten');
  return modulePromise;
}

function sharedQuickJS(): Promise<QuickJSWASMModule> {
  wasmPromise ??= loadQuickJS()
    .then((module) => module.getQuickJS())
    .catch((error: unknown) => {
      wasmPromise = undefined;
      throw error;
    });
  return wasmPromise;
}

/** Import one bundle in QuickJS and return the manifest it exports. */
export async function readToolDefinition(
  source: string,
  options: DefinitionReadOptions = {},
): Promise<DefinitionReadResult> {
  if (typeof source !== 'string' || source.length === 0) {
    throw new TypeError('readToolDefinition requires a non-empty bundle source');
  }
  const sourceBytes = Buffer.byteLength(source, 'utf8');
  if (sourceBytes > SANDBOX_MAX_BUNDLE_BYTES) {
    throw new RangeError(
      `the bundle is ${sourceBytes} bytes, over the ${SANDBOX_MAX_BUNDLE_BYTES} byte limit`,
    );
  }
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  if (timeoutMs > SANDBOX_MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be at most ${SANDBOX_MAX_TIMEOUT_MS}`);
  }
  const memoryBytes = positiveInteger(options.memoryBytes, SANDBOX_MEMORY_BYTES, 'memoryBytes');
  const maxManifestBytes = positiveInteger(
    options.maxManifestBytes,
    DEFAULT_MAX_MANIFEST_BYTES,
    'maxManifestBytes',
  );
  if (maxManifestBytes > SANDBOX_MAX_BRIDGE_BYTES) {
    throw new RangeError(
      `maxManifestBytes must be at most ${SANDBOX_MAX_BRIDGE_BYTES}; a larger string can abort the QuickJS teardown`,
    );
  }

  const [quickjs, wasm] = await Promise.all([loadQuickJS(), sharedQuickJS()]);
  const runtime = wasm.newRuntime();
  let context: QuickJSContext | undefined;
  const deadline = Date.now() + timeoutMs;

  try {
    runtime.setMemoryLimit(memoryBytes);
    runtime.setMaxStackSize(SANDBOX_STACK_BYTES);
    runtime.setInterruptHandler(() => Date.now() > deadline);
    runtime.setModuleLoader((name) => {
      if (name === MODULE_NAME) return source;
      // Node builtins are external in every bundle. Give the definition read an
      // inert module with the imported names set to undefined: the bundle's top
      // level can link, but it cannot call a host function. The runtime later
      // refuses a node builtin with its own clear message. Anything else (for
      // example an external `zod`) is a bundling mistake and fails here.
      if (name.startsWith('node:')) return inertNodeModule(source, name);
      return {
        error: new Error(
          `the bundle has a static import that the sandbox cannot resolve — bundle everything (missing "${name}")`,
        ),
      };
    });

    context = runtime.newContext();
    const ctx = context;
    return quickjs.Scope.withScope((scope) =>
      readDefinition(quickjs, scope, ctx, runtime, deadline, timeoutMs, memoryBytes, maxManifestBytes),
    );
  } finally {
    disposeCall(context, runtime);
  }
}

function readDefinition(
  quickjs: QuickJSModule,
  scope: Scope,
  ctx: QuickJSContext,
  runtime: QuickJSRuntime,
  deadline: number,
  timeoutMs: number,
  memoryBytes: number,
  maxManifestBytes: number,
): DefinitionReadResult {
  const result = ctx.evalCode(definitionScript(maxManifestBytes), 'z1-definition.js');
  if (quickjs.isFail(result)) {
    throw vmError(
      scope,
      ctx,
      scope.manage(result.error),
      timeoutMs,
      memoryBytes,
    );
  }
  const promise = scope.manage(result.value);
  const text = settle(quickjs, scope, ctx, runtime, promise, deadline, timeoutMs, memoryBytes);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxManifestBytes) {
    throw new Error(
      `manifest_too_large: the manifest is ${bytes} bytes, over the ${maxManifestBytes} byte limit`,
    );
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error('the tool bundle manifest is not valid JSON');
  }
  return { manifest };
}

/** Pump pending jobs until the import promise settles, the deadline ends, or it stalls. */
function settle(
  quickjs: QuickJSModule,
  scope: Scope,
  ctx: QuickJSContext,
  runtime: QuickJSRuntime,
  promise: QuickJSHandle,
  deadline: number,
  timeoutMs: number,
  memoryBytes: number,
): string {
  let state = ctx.getPromiseState(promise);
  for (let iteration = 0; iteration < SANDBOX_MAX_PUMP_ITERATIONS; iteration += 1) {
    if (state.type === 'fulfilled') {
      const value = scope.manage(state.value);
      if (ctx.typeof(value) !== 'string') {
        throw new Error('the tool bundle returned a non-string manifest');
      }
      return ctx.getString(value);
    }
    if (state.type === 'rejected') {
      throw vmError(scope, ctx, scope.manage(state.error), timeoutMs, memoryBytes);
    }
    if (Date.now() > deadline) {
      throw timeLimit(timeoutMs);
    }
    const jobs = runtime.executePendingJobs(1);
    if (quickjs.isFail(jobs)) {
      throw vmError(scope, ctx, scope.manage(jobs.error), timeoutMs, memoryBytes);
    }
    if (jobs.value === 0) {
      throw new Error('the tool bundle did not settle while reading its manifest');
    }
    state = ctx.getPromiseState(promise);
  }
  throw new Error(
    `the tool bundle did not settle within ${SANDBOX_MAX_PUMP_ITERATIONS} pending jobs`,
  );
}

/**
 * Read a VM error through its `.message`, never through `dump()` alone (an
 * Error dumps as `[object Object]`). Only the first line and at most 4 KiB
 * cross, so a stack can never reach the CLI.
 */
function vmError(
  scope: Scope,
  ctx: QuickJSContext,
  handle: QuickJSHandle,
  timeoutMs: number,
  memoryBytes: number,
): Error {
  if (ctx.typeof(handle) === 'string') {
    return new Error(oneLine(stringHead(scope, ctx, handle)));
  }
  const name = propertyString(scope, ctx, handle, 'name');
  const message = propertyString(scope, ctx, handle, 'message') ?? dumpSafely(ctx, handle);
  if (name === 'InternalError' && /interrupted/i.test(message)) return timeLimit(timeoutMs);
  if (/stack overflow|maximum call stack size exceeded/i.test(message)) {
    return new Error('the tool bundle exceeded the sandbox stack limit (runaway recursion)');
  }
  if (name === 'InternalError' && /out of memory/i.test(message)) {
    return new Error(`the tool bundle exceeded the sandbox memory limit of ${memoryBytes} bytes`);
  }
  const detail = oneLine(message);
  if (detail.length > 0) return new Error(detail);
  return new Error(name === undefined || name === '' ? 'the tool bundle threw' : `${name}: the tool bundle threw`);
}

function timeLimit(timeoutMs: number): Error {
  return new Error(`the tool bundle exceeded its ${timeoutMs} ms definition budget`);
}

function propertyString(
  scope: Scope,
  ctx: QuickJSContext,
  handle: QuickJSHandle,
  key: string,
): string | undefined {
  try {
    const property = scope.manage(ctx.getProp(handle, key));
    return ctx.typeof(property) === 'string' ? stringHead(scope, ctx, property) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read at most {@link MAX_ERROR_MESSAGE} characters of a VM string.
 *
 * A thrown value is attacker-controlled: `ctx.getString` materialises the whole
 * thing on the host (measured: +40 MB of external memory for a 40 MiB throw) and
 * a multi-megabyte crossing is exactly what makes the QuickJS teardown print its
 * abort line. The VM caps the value before it crosses (see `definitionScript`);
 * this is the second line of defence for a string that arrives another way.
 */
function stringHead(scope: Scope, ctx: QuickJSContext, handle: QuickJSHandle): string {
  const length = propertyLength(scope, ctx, handle);
  if (length === undefined || length <= MAX_ERROR_MESSAGE) return ctx.getString(handle);
  const slice = scope.manage(ctx.getProp(handle, 'slice'));
  if (ctx.typeof(slice) !== 'function') return ctx.getString(handle).slice(0, MAX_ERROR_MESSAGE);
  const from = scope.manage(ctx.newNumber(0));
  const to = scope.manage(ctx.newNumber(MAX_ERROR_MESSAGE));
  const head = ctx.callFunction(slice, handle, [from, to]);
  if (head.error !== undefined) {
    head.error.dispose();
    return '';
  }
  const value = scope.manage(head.value);
  return ctx.typeof(value) === 'string' ? ctx.getString(value) : '';
}

function propertyLength(
  scope: Scope,
  ctx: QuickJSContext,
  handle: QuickJSHandle,
): number | undefined {
  try {
    const property = scope.manage(ctx.getProp(handle, 'length'));
    if (ctx.typeof(property) !== 'number') return undefined;
    const value = ctx.getNumber(property);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function dumpSafely(ctx: QuickJSContext, handle: QuickJSHandle): string {
  try {
    const dumped: unknown = ctx.dump(handle);
    if (typeof dumped === 'string') return dumped;
    const text = JSON.stringify(dumped);
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

function oneLine(message: string): string {
  const first = message.split(/\r?\n/, 1)[0] ?? '';
  return first.length > MAX_ERROR_MESSAGE ? `${first.slice(0, MAX_ERROR_MESSAGE)}...` : first;
}


/**
 * Build an inert module for a node builtin that esbuild left external.
 *
 * Named imports are read from the bundle's own import/export syntax so the
 * linker can bind them; every binding is `undefined`. No host module is loaded
 * and no host function is exposed. The runtime, not this reader, is where a
 * node builtin is refused at run time.
 */
function inertNodeModule(source: string, name: string): string {
  const names = new Set<string>();
  let hasDefault = false;
  const importPattern = /import\s+([^;'"]+?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importPattern)) {
    if (match[2] !== name) continue;
    const clause = match[1] ?? '';
    if (!clause.trim().startsWith('{') && !clause.includes('*')) hasDefault = true;
    const brace = /\{([^}]*)\}/.exec(clause);
    if (brace !== null) {
      for (const part of brace[1]?.split(',') ?? []) {
        const imported = part.trim().split(/\s+as\s+/)[0] ?? '';
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(imported)) {
          if (imported === 'default') hasDefault = true;
          else names.add(imported);
        }
      }
    }
  }
  const exportPattern = /export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(exportPattern)) {
    if (match[2] !== name) continue;
    for (const part of match[1]?.split(',') ?? []) {
      const imported = part.trim().split(/\s+as\s+/)[0] ?? '';
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(imported)) {
        if (imported === 'default') hasDefault = true;
        else names.add(imported);
      }
    }
  }
  const lines: string[] = [];
  if (hasDefault) lines.push('export default undefined;');
  for (const imported of names) lines.push(`export const ${imported} = undefined;`);
  lines.push('export {};');
  return lines.join('\n');
}

function definitionScript(maxManifestBytes: number): string {
  return `(async function () {
  'use strict';
  try {
    var mod = await import(${JSON.stringify(MODULE_NAME)});
    var candidate = mod.tool != null ? mod.tool : mod.default;
    if (candidate === null || typeof candidate !== 'object') {
      throw new Error('the bundle must export a tool created with defineTool (named export "tool" or default export)');
    }
    if (typeof candidate.run !== 'function') {
      throw new Error('the bundle must export a tool created with defineTool (named export "tool" or default export): run is not a function');
    }
    var manifest = candidate.manifest;
    if (manifest === undefined || manifest === null) {
      throw new Error('the bundle must export a tool created with defineTool (named export "tool" or default export): manifest is missing or malformed');
    }
    var text;
    try {
      text = JSON.stringify(manifest);
    } catch (error) {
      throw new Error('the bundle manifest is not JSON-serializable');
    }
    if (typeof text !== 'string') {
      throw new Error('the bundle manifest is not JSON-serializable');
    }
    var bytes = utf8Length(text);
    if (bytes > ${maxManifestBytes}) {
      throw new Error('manifest_too_large: the manifest is ' + bytes + ' bytes, over the ${maxManifestBytes} byte limit');
    }
    return text;
  } catch (error) {
    // A thrown value is attacker-controlled: cap it here, inside the VM, so a
    // multi-megabyte string never crosses to the host (a crossing that size
    // makes the QuickJS teardown print its abort line). An engine-level
    // InternalError keeps its identity so the host can map interrupted and
    // out-of-memory to their own messages; those are short by construction.
    if (
      error !== null &&
      typeof error === 'object' &&
      error.name === 'InternalError' &&
      typeof error.message === 'string' &&
      error.message.length <= 512
    ) {
      throw error;
    }
    var message = error !== null && typeof error === 'object' && error.message !== undefined
      ? error.message
      : error;
    var detail = message === null || message === undefined ? 'the bundle threw' : String(message);
    throw detail.slice(0, ${MAX_ERROR_MESSAGE});
  }
  ${VM_UTF8_LENGTH}
})()`;
}

/**
 * UTF-8 byte length, so the cap is measured in the same unit as the host.
 * Kept in the VM: a 1.29 MB string is exactly what must not cross first.
 */
const VM_UTF8_LENGTH = String.raw`function utf8Length(text) {
  var bytes = 0;
  for (var index = 0; index < text.length; index += 1) {
    var code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < text.length &&
      (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}`;

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive integer`);
  }
  return value;
}

/**
 * Guarded teardown, same contract as the sandbox's: a leaked handle or a large
 * string can make `dispose()` throw the documented catchable abort, and that
 * must never mask the definition error that came before it.
 */
/**
 * The exact text the QuickJS WASM module prints when a teardown finds a live
 * object. It is measured, not guessed (see `SECURITY.md`), and it is the only
 * line this module suppresses while it disposes its own runtime.
 */
const TEARDOWN_ASSERTION = 'Aborted(Assertion failed: list_empty(&rt->gc_obj_list)';

/**
 * Guarded teardown, same contract as the sandbox's: a leaked handle or a large
 * value can make `dispose()` throw the documented catchable abort, and that must
 * never mask the definition error that came before it.
 *
 * The abort is also *printed* by the WASM module, and a reader has no business
 * writing `Aborted(Assertion failed: … JS_FreeRuntime)` above the real
 * `build_failed` line just because a hostile bundle allocated a lot. The filter
 * below drops that one exact line and nothing else; it is restored in `finally`.
 */
function disposeCall(context: QuickJSContext | undefined, runtime: QuickJSRuntime): void {
  const original = process.stderr.write.bind(process.stderr);
  const filtered = ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === 'string' && chunk.includes(TEARDOWN_ASSERTION)) return true;
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  process.stderr.write = filtered;
  try {
    if (context !== undefined) {
      try {
        context.dispose();
      } catch {
        // Best effort; the runtime dispose below is still guarded.
      }
    }
    try {
      runtime.dispose();
    } catch {
      // Never rethrow over the read's own error. The abort is a library bug with
      // large values, and the shared WASM module stays usable.
    }
  } finally {
    process.stderr.write = original;
  }
}
