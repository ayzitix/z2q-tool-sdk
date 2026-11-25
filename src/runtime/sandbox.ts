import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule,
  Scope,
} from 'quickjs-emscripten';
import type { Json } from '../types.js';
import type { Broker } from './broker.js';
import { ToolRuntimeError, codeFromMessage, detailFromMessage } from './errors.js';
import type { ToolRuntimeCode } from './errors.js';
import { SANDBOX_MAX_BRIDGE_BYTES, SANDBOX_MAX_PUMP_ITERATIONS, SANDBOX_STACK_BYTES } from './limits.js';
import { ENTRY_SOURCE, SHIM_SOURCE } from './shim.js';

/**
 * The QuickJS half of the runtime: one runtime, one context, one `Scope` per
 * call, and every handle managed.
 *
 * Handle discipline is the whole game here. A handle that is still alive when
 * `runtime.dispose()` runs makes the dispose throw a catchable abort
 * (`Aborted(Assertion failed: ... JS_FreeRuntime)`, printed by the WASM module);
 * the shared module stays usable and later calls are correct, but an unguarded
 * dispose in the host would take the process down. {@link disposeCall} therefore
 * keeps its `try/catch`. Rules followed below:
 *
 * - everything returned by `evalCode`, `getProp`, `newFunction`, `newString`,
 *   `callFunction` and `getPromiseState` is passed to `scope.manage`;
 * - the promise state's `value` / `error` are managed too;
 * - a handle returned *from* the host function is never disposed: ownership
 *   transfers to the VM.
 */

export interface SandboxInput {
  /** The tool bundle (ESM) served for `import('z1-tool-sdk')`. */
  readonly source: string;
  readonly argsJson: string;
  readonly workspace: string;
  readonly tool: string;
  readonly memoryBytes: number;
  readonly deadline: number;
  readonly now: () => number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal | undefined;
  readonly broker: Broker;
}

type QuickJSModule = typeof import('quickjs-emscripten');

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

/** Run one tool call inside a fresh QuickJS runtime and return its value. */
export async function runInSandbox(input: SandboxInput): Promise<Json> {
  const [quickjs, wasm] = await Promise.all([loadQuickJS(), sharedQuickJS()]);
  const runtime = wasm.newRuntime();
  let context: QuickJSContext | undefined;

  try {
    runtime.setMemoryLimit(input.memoryBytes);
    runtime.setMaxStackSize(SANDBOX_STACK_BYTES);
    runtime.setInterruptHandler(
      () => input.signal?.aborted === true || input.now() > input.deadline,
    );
    runtime.setModuleLoader((name) => {
      if (name === 'z1-tool-sdk') return input.source;
      return {
        error: new Error(
          `invalid_tool: the tool bundle requests the module "${name}", which the sandbox does not provide`,
        ),
      };
    });

    context = runtime.newContext();
    const ctx = context;
    return quickjs.Scope.withScope((scope) => evaluate(quickjs, scope, ctx, runtime, input));
  } finally {
    disposeCall(context, runtime);
  }
}

function evaluate(
  quickjs: QuickJSModule,
  scope: Scope,
  ctx: QuickJSContext,
  runtime: QuickJSRuntime,
  input: SandboxInput,
): Json {
  installBridge(ctx, scope, input);
  evaluateScript(quickjs, scope, ctx, SHIM_SOURCE, 'z1-shim.js', input);
  evaluateScript(quickjs, scope, ctx, ENTRY_SOURCE, 'z1-entry.js', input);

  const global = ctx.global;
  const runHandle = scope.manage(ctx.getProp(global, '__z1_run'));
  if (ctx.typeof(runHandle) !== 'function') {
    throw new ToolRuntimeError('invalid_tool', 'the sandbox entry point is missing', {
      tool: input.tool,
    });
  }
  const argsHandle = scope.manage(ctx.newString(input.argsJson));
  const call = ctx.callFunction(runHandle, ctx.undefined, [argsHandle]);
  if (quickjs.isFail(call)) {
    throw readVmError(scope, ctx, scope.manage(call.error), input);
  }
  const promise = scope.manage(call.value);

  readMarker(settle(quickjs, scope, ctx, runtime, promise, input), input);
  return decodeEnvelope(readEnvelope(quickjs, scope, ctx, input), input);
}

/** Install the single host function and the two strings it reads. */
function installBridge(ctx: QuickJSContext, scope: Scope, input: SandboxInput): void {
  const global = ctx.global;
  const invoke = scope.manage(
    ctx.newFunction('__z1_invoke', (kindHandle, payloadHandle) => {
      // n1: `__z1_invoke()` used to reach the host and leak a V8 message
      // ("Cannot read properties of undefined (reading 'owner')") into the VM.
      if (
        kindHandle === undefined ||
        payloadHandle === undefined ||
        ctx.typeof(kindHandle) !== 'string' ||
        ctx.typeof(payloadHandle) !== 'string'
      ) {
        throw new Error(
          'invalid_arguments: __z1_invoke(kind, payloadJson) needs two string arguments',
        );
      }
      const kind = ctx.getString(kindHandle);
      const payloadJson = ctx.getString(payloadHandle);
      try {
        // Ownership of this handle transfers to the VM; never dispose it.
        return ctx.newString(input.broker.invoke(kind, payloadJson));
      } catch (error) {
        // Only the message crosses the boundary; the VM sees a plain Error.
        throw new Error(vmMessage(error));
      }
    }),
  );
  ctx.setProp(global, '__z1_invoke', invoke);
  ctx.setProp(global, '__z1_args', scope.manage(ctx.newString(input.argsJson)));
  ctx.setProp(global, '__z1_workspace', scope.manage(ctx.newString(input.workspace)));
}

/** Evaluate a VM-side script for its effect and dispose both result branches. */
function evaluateScript(
  quickjs: QuickJSModule,
  scope: Scope,
  ctx: QuickJSContext,
  source: string,
  filename: string,
  input: SandboxInput,
): void {
  const result = ctx.evalCode(source, filename);
  if (quickjs.isFail(result)) {
    throw readVmError(scope, ctx, scope.manage(result.error), input);
  }
  scope.manage(result.value);
}

/** Code units requested per `__z1_encode` call; a reply may shrink below it. */
const ENVELOPE_CHUNK = 262_144;
/** 128 chunks of 262 144 code units is 32 MiB, well past the 8 MiB result cap. */
const MAX_ENVELOPE_CHUNKS = 128;

/**
 * Pull the `{ __z1_ok }` envelope out of the VM in chunks.
 *
 * The encoder is a top-level function (`__z1_encode(offset, length)`) rather than
 * a `JSON.stringify` inside the module's async frame: a multi-megabyte string
 * built in that frame is what leaves the internal object behind (measured, see
 * `SECURITY.md`), and a chunked reply keeps every crossing under the bridge cap.
 */
function readEnvelope(
  quickjs: QuickJSModule,
  scope: Scope,
  ctx: QuickJSContext,
  input: SandboxInput,
): string {
  const encode = scope.manage(ctx.getProp(ctx.global, '__z1_encode'));
  if (ctx.typeof(encode) !== 'function') {
    throw new ToolRuntimeError('invalid_tool', 'the sandbox result encoder is missing', {
      tool: input.tool,
    });
  }
  let text = '';
  let offset = 0;
  let length = ENVELOPE_CHUNK;
  for (let iteration = 0; iteration < MAX_ENVELOPE_CHUNKS; iteration += 1) {
    const offsetHandle = scope.manage(ctx.newNumber(offset));
    const lengthHandle = scope.manage(ctx.newNumber(length));
    const call = ctx.callFunction(encode, ctx.undefined, [offsetHandle, lengthHandle]);
    if (quickjs.isFail(call)) {
      throw readVmError(scope, ctx, scope.manage(call.error), input);
    }
    const reply = ctx.getString(scope.manage(call.value));
    const bytes = Buffer.byteLength(reply, 'utf8');
    if (bytes > SANDBOX_MAX_BRIDGE_BYTES) {
      if (length <= 1) {
        throw new ToolRuntimeError(
          'output_too_large',
          `one result chunk is ${bytes} bytes, over the ${SANDBOX_MAX_BRIDGE_BYTES} byte bridge limit`,
          { tool: input.tool },
        );
      }
      length = Math.max(1, Math.floor(length / 2));
      continue;
    }
    const chunk = parseEnvelopeChunk(reply, input);
    text += chunk.data;
    const total = Buffer.byteLength(text, 'utf8');
    if (total > input.maxOutputBytes) {
      throw new ToolRuntimeError(
        'output_too_large',
        `the tool result is ${total} bytes, over the ${input.maxOutputBytes} byte limit`,
        { tool: input.tool },
      );
    }
    if (chunk.next === null) return text;
    if (chunk.next <= offset) {
      throw new ToolRuntimeError(
        'invalid_output',
        'the sandbox returned a non-advancing result offset',
        { tool: input.tool },
      );
    }
    offset = chunk.next;
  }
  throw new ToolRuntimeError(
    'output_too_large',
    `the tool result did not fit in ${MAX_ENVELOPE_CHUNKS} chunks of ${ENVELOPE_CHUNK} code units`,
    { tool: input.tool },
  );
}

function parseEnvelopeChunk(reply: string, input: SandboxInput): { data: string; next: number | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    throw new ToolRuntimeError('invalid_output', 'the sandbox returned a malformed result chunk', {
      tool: input.tool,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ToolRuntimeError('invalid_output', 'the sandbox returned a malformed result chunk', {
      tool: input.tool,
    });
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.data !== 'string') {
    throw new ToolRuntimeError('invalid_output', 'the sandbox returned a non-string result chunk', {
      tool: input.tool,
    });
  }
  const next = record.next;
  if (next !== null && (typeof next !== 'number' || !Number.isInteger(next))) {
    throw new ToolRuntimeError('invalid_output', 'the sandbox returned a bad result offset', {
      tool: input.tool,
    });
  }
  return { data: record.data, next: next as number | null };
}

/** Pump pending jobs until the entry promise settles, the budget ends, or it stalls. */
function settle(
  quickjs: QuickJSModule,
  scope: Scope,
  ctx: QuickJSContext,
  runtime: QuickJSRuntime,
  promise: QuickJSHandle,
  input: SandboxInput,
): string {
  let state = ctx.getPromiseState(promise);
  for (let iteration = 0; iteration < SANDBOX_MAX_PUMP_ITERATIONS; iteration += 1) {
    if (state.type === 'fulfilled') {
      const value = scope.manage(state.value);
      if (ctx.typeof(value) !== 'string') {
        throw new ToolRuntimeError('invalid_output', 'the tool returned a non-string envelope', {
          tool: input.tool,
        });
      }
      return ctx.getString(value);
    }
    if (state.type === 'rejected') {
      throw readVmError(scope, ctx, scope.manage(state.error), input);
    }
    if (input.signal?.aborted === true) {
      throw new ToolRuntimeError('time_limit', 'the call was aborted by the caller', {
        tool: input.tool,
      });
    }
    if (input.now() > input.deadline) {
      throw exceededTime(input);
    }
    const jobs = runtime.executePendingJobs(1);
    if (quickjs.isFail(jobs)) {
      throw readVmError(scope, ctx, scope.manage(jobs.error), input);
    }
    if (jobs.value === 0) {
      throw new ToolRuntimeError(
        'loop_limit',
        'the tool is waiting for a promise that will never settle',
        { tool: input.tool },
      );
    }
    state = ctx.getPromiseState(promise);
  }
  throw new ToolRuntimeError(
    'loop_limit',
    `the tool did not settle within ${SANDBOX_MAX_PUMP_ITERATIONS} pending jobs`,
    { tool: input.tool },
  );
}

function exceededTime(input: SandboxInput): ToolRuntimeError {
  return new ToolRuntimeError('time_limit', 'the call exceeded its time budget', {
    tool: input.tool,
  });
}

/**
 * Read a VM error without ever touching its stack, map `InternalError` and
 * coded messages onto {@link ToolRuntimeCode}, and fall back to `tool_threw`.
 */
function readVmError(
  scope: Scope,
  ctx: QuickJSContext,
  handle: QuickJSHandle,
  input: SandboxInput,
): ToolRuntimeError {
  const type = ctx.typeof(handle);
  if (type === 'string') {
    return fromMessage(ctx.getString(handle), input);
  }
  const name = propertyString(scope, ctx, handle, 'name');
  const message = propertyString(scope, ctx, handle, 'message') ?? dumpSafely(ctx, handle);
  if (name === 'InternalError' && /interrupted/i.test(message)) return exceededTime(input);
  // n4: a stack overflow is a loop-limit problem, not a tool that threw, and it
  // must not surface a host RangeError message or a host stack frame.
  if (/stack overflow|maximum call stack size exceeded/i.test(message)) {
    return new ToolRuntimeError(
      'loop_limit',
      'the call exceeded the sandbox stack limit (runaway recursion)',
      { tool: input.tool },
    );
  }
  if (name === 'InternalError' && /out of memory/i.test(message)) {
    return new ToolRuntimeError(
      'memory_limit',
      `the call exceeded the sandbox memory limit of ${input.memoryBytes} bytes`,
      { tool: input.tool },
    );
  }
  return fromMessage(message, input, name);
}

function fromMessage(message: string, input: SandboxInput, name?: string): ToolRuntimeError {
  const capped = message.length > 4096 ? `${message.slice(0, 4096)}...` : message;
  const code = codeFromMessage(capped);
  if (code !== undefined) {
    return new ToolRuntimeError(code, detailFromMessage(capped), { tool: input.tool });
  }
  const detail =
    name !== undefined && name !== '' && name !== 'Error' ? `${name}: ${capped}` : capped;
  return new ToolRuntimeError('tool_threw', detail || 'the tool threw', { tool: input.tool });
}

function propertyString(
  scope: Scope,
  ctx: QuickJSContext,
  handle: QuickJSHandle,
  key: string,
): string | undefined {
  const property = scope.manage(ctx.getProp(handle, key));
  return ctx.typeof(property) === 'string' ? ctx.getString(property) : undefined;
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

/** Read the small `{ __z1_status }` / `{ __z1_invalid }` marker from `__z1_run`. */
function readMarker(text: string, input: SandboxInput): void {
  let marker: unknown;
  try {
    marker = JSON.parse(text);
  } catch {
    throw new ToolRuntimeError('invalid_output', 'the tool returned a non-JSON marker', {
      tool: input.tool,
    });
  }
  if (typeof marker !== 'object' || marker === null || Array.isArray(marker)) {
    throw new ToolRuntimeError('invalid_output', 'the tool returned an unexpected marker', {
      tool: input.tool,
    });
  }
  const record = marker as Record<string, unknown>;
  if ('__z1_invalid' in record) {
    const issues = Array.isArray(record.__z1_invalid) ? record.__z1_invalid : [];
    throw invalidArguments(issues, input);
  }
  if (record.__z1_status === 'ready') return;
  throw new ToolRuntimeError('invalid_output', 'the tool returned an unexpected marker', {
    tool: input.tool,
  });
}

/** Turn the `{ __z1_ok }` envelope into a value, applying the output cap. */
function decodeEnvelope(text: string, input: SandboxInput): Json {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > input.maxOutputBytes) {
    throw new ToolRuntimeError(
      'output_too_large',
      `the tool result is ${bytes} bytes, over the ${input.maxOutputBytes} byte limit`,
      { tool: input.tool },
    );
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new ToolRuntimeError('invalid_output', 'the tool result is not valid JSON', {
      tool: input.tool,
    });
  }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new ToolRuntimeError('invalid_output', 'the tool result is not a JSON object', {
      tool: input.tool,
    });
  }
  const record = envelope as Record<string, unknown>;
  if ('__z1_invalid' in record) {
    const issues = Array.isArray(record.__z1_invalid) ? record.__z1_invalid : [];
    throw invalidArguments(issues, input);
  }
  if (!('__z1_ok' in record)) {
    throw new ToolRuntimeError(
      'invalid_output',
      'the tool returned a value that is not JSON-serializable',
      { tool: input.tool },
    );
  }
  return record.__z1_ok as Json;
}

function invalidArguments(issues: readonly unknown[], input: SandboxInput): ToolRuntimeError {
  return new ToolRuntimeError(
    'invalid_arguments',
    `invalid arguments for ${input.tool}: ${formatIssues(issues)}`,
    { tool: input.tool, details: JSON.parse(JSON.stringify(issues)) as Json },
  );
}

function formatIssues(issues: readonly unknown[]): string {
  if (issues.length === 0) return 'the arguments did not match the schema';
  return issues
    .map((issue) => {
      const record =
        typeof issue === 'object' && issue !== null ? (issue as Record<string, unknown>) : {};
      const path = Array.isArray(record.path) ? record.path.map(String).join('.') : '';
      const message = typeof record.message === 'string' ? record.message : 'invalid';
      return `${path === '' ? '(root)' : path}: ${message}`;
    })
    .join('; ');
}

function vmMessage(error: unknown): string {
  if (error instanceof ToolRuntimeError) return `${error.code}: ${error.message}`;
  return 'tool_threw: the sandbox broker failed';
}

function disposeCall(context: QuickJSContext | undefined, runtime: QuickJSRuntime): void {
  if (context !== undefined) {
    try {
      context.dispose();
    } catch {
      // A leaked handle surfaces here as QuickJSMemoryLeakDetected. There is
      // nothing to repair, and disposing the runtime next may abort; keeping the
      // original error is more useful than masking it.
    }
  }
  try {
    runtime.dispose();
  } catch {
    // Never rethrow over the call's own error. The abort (a known library bug
    // for large values, see SECURITY.md) is catchable and the WASM module stays
    // usable, so a host that disposes its own runtime must guard it the same way.
  }
}
