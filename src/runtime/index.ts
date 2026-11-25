import { isToolManifest } from '../manifest.js';
import type { Json, LogLevel } from '../types.js';
import { AuditCollector, toAuditSink } from './audit.js';
import type { AuditRow, AuditSink } from './audit.js';
import { Broker } from './broker.js';
import { ToolRuntimeError } from './errors.js';
import { runtimeHost } from './host.js';
import type { HostStat, RuntimeHost } from './host.js';
import {
  SANDBOX_MAX_BRIDGE_BYTES,
  SANDBOX_MAX_OUTPUT_BYTES,
  SANDBOX_MAX_TIMEOUT_MS,
  SANDBOX_MEMORY_BYTES,
} from './limits.js';
import { loadToolPackage } from './package.js';
import type { ToolPackage } from './package.js';
import { runInSandbox } from './sandbox.js';

export { ToolRuntimeError } from './errors.js';
export type { ToolRuntimeCode } from './errors.js';
export { createJsonlAuditSink, createMemoryAuditSink } from './audit.js';
export type { AuditRow, AuditSink } from './audit.js';
export { loadToolPackage } from './package.js';
export type { ToolPackage } from './package.js';
export {
  SANDBOX_MAX_AUDIT_ROWS,
  SANDBOX_MAX_BRIDGE_BYTES,
  SANDBOX_MAX_BUNDLE_BYTES,
  SANDBOX_MAX_GLOB_RESULTS,
  SANDBOX_MAX_GREP_MATCHES,
  SANDBOX_MAX_OUTPUT_BYTES,
  SANDBOX_MAX_PUMP_ITERATIONS,
  SANDBOX_MAX_READ_BYTES,
  SANDBOX_MAX_TIMEOUT_MS,
  SANDBOX_MEMORY_BYTES,
  SANDBOX_STACK_BYTES,
} from './limits.js';

/** How a runtime is configured. `workspace` is the only filesystem root there is. */
export interface ToolRuntimeOptions {
  /** Absolute workspace root; every fs and cwd path must stay inside it. */
  workspace: string;
  /** Where audit rows go. An array is treated as a memory sink. */
  audit?: AuditSink | AuditRow[] | null;
  /** Host ceiling over `manifest.capabilities.limits.timeoutMs`. Default 60000. */
  maxTimeoutMs?: number;
  /** Per-call QuickJS heap. Default 128 MiB. */
  memoryBytes?: number;
  /** Host ceiling for one result. Default 8 MiB, still capped by the manifest. */
  maxOutputBytes?: number;
  process?: {
    /**
     * Base environment for children, used as given: nothing is inherited unless
     * you name it here. Defaults to {@link OS_ENV_ALLOW_LIST}.
     */
    env?: Record<string, string>;
    /**
     * Use the whole host `process.env` as the base environment. Off by default,
     * because a `process.run` grant would otherwise also be a grant to read
     * every secret the host holds (see `SECURITY.md`).
     */
    inheritEnv?: boolean;
    /** Default per-child timeout, always bounded by the call budget. */
    timeoutMs?: number;
    /** Captured stdout/stderr budget for one child. */
    maxOutputBytes?: number;
  };
  /** v1 only supports `false`: the bridge is synchronous and a fetch is not. */
  net?: false;
  /** Injectable clock, default `Date.now`. */
  now?: () => number;
  /**
   * Where tool logs (`ctx.log`, `console.*`) go. Default: dropped.
   *
   * This option is an addition to the original brief, which left log routing
   * unspecified; the CLI wires it to stderr.
   */
  onLog?: (level: LogLevel, message: string) => void;
}

/** Per-call options. */
export interface ToolRunOptions {
  /** Aborts the call; observed before and after each host action. */
  signal?: AbortSignal;
  /** Lower the call budget for this run only. */
  timeoutMs?: number;
}

/** What a successful call returns. */
export interface ToolRunResult {
  value: Json;
  tool: string;
  version: string;
  durationMs: number;
  audit: readonly AuditRow[];
}

interface NormalizedOptions {
  readonly workspace: string;
  readonly audit: AuditSink | undefined;
  readonly maxTimeoutMs: number;
  readonly memoryBytes: number;
  readonly maxOutputBytes: number;
  readonly processEnv: Record<string, string>;
  readonly processTimeoutMs: number | undefined;
  readonly processMaxOutputBytes: number;
  readonly now: () => number;
  readonly onLog: ((level: LogLevel, message: string) => void) | undefined;
}

/**
 * A sandboxed tool runtime. One QuickJS runtime is created and disposed per
 * call, so a tool cannot leave state behind. A leaked handle makes `dispose()`
 * throw a catchable abort (see `AGENTS.md` rule 9), which is why every handle
 * goes through a `Scope` in `sandbox.ts`.
 *
 * Prefer the {@link createToolRuntime} factory: it loads the host modules and
 * validates options before the first call.
 */
export class ToolRuntime {
  readonly #options: NormalizedOptions;
  readonly #host: RuntimeHost;
  #warned = false;

  private constructor(options: NormalizedOptions, host: RuntimeHost) {
    this.#options = options;
    this.#host = host;
  }

  /** Build a runtime. Equivalent to {@link createToolRuntime}. */
  static async create(options: ToolRuntimeOptions): Promise<ToolRuntime> {
    const host = await runtimeHost();
    return new ToolRuntime(normalizeOptions(options, host), host);
  }

  /** Run a built tool package, or a tool directory containing `dist/`. */
  async run(
    pkg: ToolPackage | string,
    args?: unknown,
    runOptions: ToolRunOptions = {},
  ): Promise<ToolRunResult> {
    const started = this.#options.now();
    const signal = runOptions.signal;
    if (signal?.aborted === true) {
      throw new ToolRuntimeError('time_limit', 'the call was aborted by the caller');
    }

    const toolPackage = typeof pkg === 'string' ? await loadToolPackage(pkg) : pkg;
    const manifest = toolPackage.manifest;
    if (!isToolManifest(manifest)) {
      throw new ToolRuntimeError('invalid_tool', 'the tool manifest is malformed');
    }
    const tool = manifest.name;
    const version = manifest.version;

    const argsJson = serializeArgs(args, tool);
    const budgetMs = callBudget(manifest.capabilities.limits.timeoutMs, this.#options, runOptions);
    const deadline = this.#options.now() + budgetMs;
    const outputCap = Math.min(
      manifest.capabilities.limits.maxOutputBytes,
      this.#options.maxOutputBytes,
    );
    const processCap = Math.min(
      manifest.capabilities.limits.maxOutputBytes,
      this.#options.processMaxOutputBytes,
    );
    const audit = new AuditCollector(tool, version, this.#options.now);
    const broker = new Broker({
      workspace: this.#options.workspace,
      manifest,
      audit,
      now: this.#options.now,
      deadline,
      budgetMs,
      maxOutputBytes: outputCap,
      process: {
        env: this.#options.processEnv,
        timeoutMs: this.#options.processTimeoutMs,
        maxOutputBytes: processCap,
      },
      signal,
      host: this.#host,
      ...(this.#options.onLog === undefined ? {} : { onLog: this.#options.onLog }),
      warn: (message: string) => this.warn(message),
    });

    let value: Json | undefined;
    let failure: ToolRuntimeError | undefined;
    try {
      value = await runInSandbox({
        source: toolPackage.source,
        argsJson,
        workspace: this.#options.workspace,
        tool,
        memoryBytes: this.#options.memoryBytes,
        deadline,
        now: this.#options.now,
        maxOutputBytes: outputCap,
        signal,
        broker,
      });
    } catch (error) {
      failure = asRuntimeError(error, tool);
    }

    const rows = audit.finish();
    await this.flush(rows);
    if (failure !== undefined) throw failure;
    return {
      value: value as Json,
      tool,
      version,
      durationMs: Math.max(0, this.#options.now() - started),
      audit: rows,
    };
  }

  private async flush(rows: readonly AuditRow[]): Promise<void> {
    const sink = this.#options.audit;
    if (sink === undefined) return;
    try {
      await sink.write(rows);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.warn(`the audit sink threw and was ignored: ${detail}`);
    }
  }

  private warn(message: string): void {
    if (this.#options.onLog !== undefined) {
      this.#options.onLog('warn', message);
      return;
    }
    if (this.#warned) return;
    this.#warned = true;
    console.warn(`z1 runtime: ${message}`);
  }
}

/** Create a sandboxed runtime. Loads QuickJS lazily on the first call. */
export function createToolRuntime(options: ToolRuntimeOptions): Promise<ToolRuntime> {
  return ToolRuntime.create(options);
}

function normalizeOptions(options: ToolRuntimeOptions, host: RuntimeHost): NormalizedOptions {
  if (typeof options !== 'object' || options === null) {
    throw new ToolRuntimeError('invalid_arguments', 'createToolRuntime requires an options object');
  }
  const workspace = options.workspace;
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw new ToolRuntimeError('invalid_arguments', 'workspace must be a non-empty absolute path');
  }
  if (!host.path.isAbsolute(workspace)) {
    throw new ToolRuntimeError('invalid_arguments', `workspace must be absolute: ${workspace}`);
  }
  const resolvedWorkspace = host.path.resolve(workspace);
  let status: HostStat;
  try {
    status = host.fs.statSync(resolvedWorkspace);
  } catch {
    throw new ToolRuntimeError('invalid_arguments', `workspace does not exist: ${resolvedWorkspace}`);
  }
  if (!status.isDirectory()) {
    throw new ToolRuntimeError('invalid_arguments', `workspace is not a directory: ${resolvedWorkspace}`);
  }

  const net = (options as { net?: unknown }).net;
  if (net !== undefined && net !== false) {
    throw new ToolRuntimeError(
      'net_not_supported',
      'the sandbox does not implement net.fetch; the z1 host performs network access',
    );
  }

  const processOptions = options.process ?? {};
  const inheritEnv = processOptions.inheritEnv;
  if (inheritEnv !== undefined && typeof inheritEnv !== 'boolean') {
    throw new ToolRuntimeError('invalid_arguments', 'process.inheritEnv must be a boolean');
  }
  // M2: a child gets an OS allow-list unless the host supplies `env` or opts in
  // to inheriting everything. A canary in the host's `process.env` is invisible.
  const processEnv =
    processOptions.env ??
    (inheritEnv === true ? readProcessEnv() : osEnvironment(host.caseInsensitive));
  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value !== 'string') {
      throw new ToolRuntimeError('invalid_arguments', `process.env.${key} must be a string`);
    }
  }

  return {
    workspace: resolvedWorkspace,
    audit: toAuditSink(options.audit),
    maxTimeoutMs: positiveInteger(options.maxTimeoutMs, SANDBOX_MAX_TIMEOUT_MS, 'maxTimeoutMs'),
    memoryBytes: positiveInteger(options.memoryBytes, SANDBOX_MEMORY_BYTES, 'memoryBytes'),
    maxOutputBytes: positiveInteger(
      options.maxOutputBytes,
      SANDBOX_MAX_OUTPUT_BYTES,
      'maxOutputBytes',
    ),
    processEnv: { ...processEnv },
    processTimeoutMs:
      processOptions.timeoutMs === undefined
        ? undefined
        : positiveInteger(processOptions.timeoutMs, SANDBOX_MAX_TIMEOUT_MS, 'process.timeoutMs'),
    processMaxOutputBytes: positiveInteger(
      processOptions.maxOutputBytes,
      SANDBOX_MAX_OUTPUT_BYTES,
      'process.maxOutputBytes',
    ),
    now: options.now ?? Date.now,
    onLog: options.onLog,
  };
}

function positiveInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ToolRuntimeError(
      'invalid_arguments',
      `${field} must be a positive integer, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * The OS variables a child process needs to start at all.
 *
 * M2: everything else the host holds — tokens, API keys, its own settings — stays
 * out of a child unless the host passes `process.env` or `process.inheritEnv`.
 */
const OS_ENV_ALLOW_LIST = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'COMSPEC',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'LANG',
  'LC_ALL',
] as const;

/** The allow-listed host variables that are present, matched case-insensitively on win32. */
function osEnvironment(caseInsensitive: boolean): Record<string, string> {
  const names: readonly string[] = caseInsensitive
    ? OS_ENV_ALLOW_LIST.map((name) => name.toLowerCase())
    : OS_ENV_ALLOW_LIST;
  const allowed = new Set(names);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    if (!allowed.has(caseInsensitive ? key.toLowerCase() : key)) continue;
    out[key] = value;
  }
  return out;
}

function readProcessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function callBudget(
  manifestTimeoutMs: number,
  options: NormalizedOptions,
  runOptions: ToolRunOptions,
): number {
  const requested = runOptions.timeoutMs ?? Number.POSITIVE_INFINITY;
  if (typeof requested !== 'number' || Number.isNaN(requested) || requested <= 0) {
    throw new ToolRuntimeError('invalid_arguments', 'timeoutMs must be a positive number');
  }
  return Math.max(1, Math.min(manifestTimeoutMs, options.maxTimeoutMs, requested));
}

function serializeArgs(args: unknown, tool: string): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(args === undefined ? {} : args);
  } catch {
    throw new ToolRuntimeError('invalid_arguments', 'tool arguments are not JSON-serializable', {
      tool,
    });
  }
  if (typeof text !== 'string') {
    throw new ToolRuntimeError('invalid_arguments', 'tool arguments are not JSON-serializable', {
      tool,
    });
  }
  // S4: an 8 MB args object crossing the bridge aborts the teardown, so the
  // argument string is held to the same cap as every other crossing.
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > SANDBOX_MAX_BRIDGE_BYTES) {
    throw new ToolRuntimeError(
      'invalid_arguments',
      `tool arguments are ${bytes} bytes, over the ${SANDBOX_MAX_BRIDGE_BYTES} byte bridge limit`,
      { tool },
    );
  }
  return text;
}

function asRuntimeError(error: unknown, tool: string): ToolRuntimeError {
  if (error instanceof ToolRuntimeError) {
    if (error.tool !== undefined) return error;
    return new ToolRuntimeError(error.code, error.message, { tool, cause: error });
  }
  const detail = error instanceof Error ? error.message : String(error);
  // n4: V8's own overflow, on the path where it escapes the VM, is a loop limit
  // rather than a tool that threw; only the first line crosses, never a frame.
  if (/maximum call stack size exceeded|stack overflow/i.test(detail)) {
    return new ToolRuntimeError(
      'loop_limit',
      'the call exceeded the sandbox stack limit (runaway recursion)',
      { tool, cause: error },
    );
  }
  const first = detail.split('\n')[0] ?? detail;
  return new ToolRuntimeError('tool_threw', `the sandbox failed: ${first}`, { tool, cause: error });
}
