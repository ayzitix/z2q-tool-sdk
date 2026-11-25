import { globToRegExp } from '../context.js';
import type {
  FsEntry,
  GrepMatch,
  LogLevel,
  ProcessRunResult,
  ToolManifest,
} from '../types.js';
import type { AuditCollector } from './audit.js';
import { ToolRuntimeError } from './errors.js';
import type { HostExecError, RuntimeHost } from './host.js';
import {
  SANDBOX_MAX_BRIDGE_BYTES,
  SANDBOX_MAX_GLOB_RESULTS,
  SANDBOX_MAX_GREP_MATCHES,
  SANDBOX_MAX_READ_BYTES,
} from './limits.js';
import {
  assertGlobPattern,
  assertListable,
  assertProcessArgv,
  assertReadable,
  assertWritable,
  assertWorkspaceDirectory,
  filterGlobResults,
  isDeniedFileName,
  isDeniedRealPath,
  isDeniedSegmentName,
  isGrantedDirectory,
  isGrantedPath,
} from './policy.js';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const MAX_LOG_MESSAGE = 64 * 1024;
const MAX_GREP_PATTERN = 4096;
const MAX_WALK_DEPTH = 64;
const MAX_ENV_ENTRIES = 256;
/** Writes buffered at once; a chunked write is flushed by `eof`. */
const MAX_PENDING_WRITES = 16;
/** `fs.grep` options the bridge understands; anything else is refused (n3). */
const GREP_OPTION_KEYS: readonly string[] = ['glob', 'ignoreCase'];

export interface BrokerProcessOptions {
  /** Base environment for children. */
  readonly env: Record<string, string>;
  readonly timeoutMs: number | undefined;
  readonly maxOutputBytes: number;
}

export interface BrokerOptions {
  readonly workspace: string;
  readonly manifest: ToolManifest;
  readonly audit: AuditCollector;
  readonly now: () => number;
  readonly deadline: number;
  readonly budgetMs: number;
  readonly maxOutputBytes: number;
  readonly process: BrokerProcessOptions;
  readonly signal: AbortSignal | undefined;
  readonly host: RuntimeHost;
  readonly onLog?: (level: LogLevel, message: string) => void;
  readonly warn?: (message: string) => void;
}

interface HandlerResult {
  /** Serialized straight into the reply; every handler returns plain JSON. */
  value: unknown;
  target: string;
}

/**
 * The broker: the only place that touches the filesystem or a child process.
 *
 * Every `__z1_invoke` from the VM lands in {@link Broker.invoke}, which checks
 * the deadline, parses the payload, dispatches, records an audit row, and turns
 * every refusal into a {@link ToolRuntimeError}. Nothing here is async, so the
 * host function stays a plain JSON-in/JSON-out call.
 */
export class Broker {
  readonly #options: BrokerOptions;
  /** One file cached between `fs.read` chunks: a 6 MB read arrives as six calls. */
  #readCache: { readonly path: string; readonly text: string } | undefined;
  /** Chunked `fs.write` buffers, keyed by resolved path, flushed on `eof`. */
  readonly #pendingWrites = new Map<string, { offset: number; bytes: number; parts: string[] }>();

  constructor(options: BrokerOptions) {
    this.#options = options;
  }

  /** Handle one bridge call. Returns `{"ok":true,"value":...}` or throws. */
  invoke(kind: string, payloadJson: string): string {
    const target = this.#targetOf(kind, payloadJson);
    const started = this.#options.now();
    try {
      this.#ensureBudget();
      assertBridgeCall(kind, payloadJson);
      const result = this.#dispatch(kind, parsePayload(payloadJson));
      this.#options.audit.allow(kind, result.target, this.#options.now() - started);
      return JSON.stringify({ ok: true, value: result.value });
    } catch (error) {
      const runtimeError = this.#asRuntimeError(error);
      this.#options.audit.deny(
        kind,
        runtimeError.code,
        runtimeError.code === 'secret_path_denied' ? '<redacted>' : target,
      );
      throw runtimeError;
    }
  }

  #dispatch(kind: string, payload: Record<string, unknown>): HandlerResult {
    switch (kind) {
      case 'fs.read':
        return this.#read(payload);
      case 'fs.write':
        return this.#write(payload);
      case 'fs.list':
        return this.#list(payload);
      case 'fs.glob':
        return this.#glob(payload);
      case 'fs.grep':
        return this.#grep(payload);
      case 'process.run':
        return this.#process(payload);
      case 'net.fetch':
        // Accepted only so the refusal is enforced and audited host-side.
        throw new ToolRuntimeError(
          'net_not_supported',
          'the sandbox has no network; the z1 host performs net.fetch',
        );
      case 'log':
        return this.#log(payload);
      default:
        throw new ToolRuntimeError('capability_denied', `the sandbox does not offer "${kind}"`);
    }
  }

  /**
   * One chunk of a file. The shim loops until `next` is `null`; each reply is
   * shrunk until the whole JSON string fits {@link SANDBOX_MAX_BRIDGE_BYTES}, so
   * no single value crossing the bridge can trip the teardown abort (S4).
   */
  #read(payload: Record<string, unknown>): HandlerResult {
    const host = this.#options.host;
    const relative = assertReadable(
      stringField(payload, 'path'),
      this.#capabilities,
      this.#workspace,
    );
    const resolved = host.path.resolve(this.#workspace, relative);
    const stat = this.#stat(resolved, `fs.read: ${relative}`);
    if (!stat.isFile()) {
      throw new ToolRuntimeError('invalid_arguments', `fs.read expects a file: ${relative}`);
    }
    if (stat.size > SANDBOX_MAX_READ_BYTES) {
      throw new ToolRuntimeError(
        'output_too_large',
        `fs.read is limited to ${SANDBOX_MAX_READ_BYTES} bytes, ${relative} is ${stat.size}`,
      );
    }
    const offset = integerField(payload, 'offset', 0);
    const length = integerField(payload, 'length', SANDBOX_MAX_BRIDGE_BYTES);
    if (offset < 0) {
      throw new ToolRuntimeError('invalid_arguments', 'fs.read offset must not be negative');
    }
    if (length <= 0) {
      throw new ToolRuntimeError('invalid_arguments', 'fs.read length must be positive');
    }
    const text = this.#cachedText(resolved, relative);
    if (offset > text.length) {
      throw new ToolRuntimeError(
        'invalid_arguments',
        `fs.read offset ${offset} is past the end of ${relative}`,
      );
    }
    return { value: readChunk(text, offset, Math.min(length, SANDBOX_MAX_BRIDGE_BYTES)), target: relative };
  }

  /**
   * A chunk of a write. Chunks are buffered in the broker and written once, at
   * `eof`, so a refused or interrupted write never leaves a partial file.
   */
  #write(payload: Record<string, unknown>): HandlerResult {
    const host = this.#options.host;
    const data = stringField(payload, 'data');
    const relative = assertWritable(
      stringField(payload, 'path'),
      this.#capabilities,
      this.#workspace,
    );
    const resolved = host.path.resolve(this.#workspace, relative);
    const offset = integerField(payload, 'offset', 0);
    const eof = booleanField(payload, 'eof', true);
    if (offset < 0) {
      throw new ToolRuntimeError('invalid_arguments', 'fs.write offset must not be negative');
    }
    const pending = this.#pendingWrites.get(resolved) ?? { offset: 0, bytes: 0, parts: [] };
    if (offset !== pending.offset) {
      throw new ToolRuntimeError(
        'invalid_arguments',
        `fs.write chunk ${relative} must continue at ${pending.offset}, not ${offset}`,
      );
    }
    const bytes = Buffer.byteLength(data, 'utf8');
    if (pending.bytes + bytes > SANDBOX_MAX_READ_BYTES) {
      throw new ToolRuntimeError(
        'output_too_large',
        `fs.write is limited to ${SANDBOX_MAX_READ_BYTES} bytes per file`,
      );
    }
    pending.parts.push(data);
    pending.offset += data.length;
    pending.bytes += bytes;
    if (!eof) {
      if (this.#pendingWrites.size >= MAX_PENDING_WRITES && !this.#pendingWrites.has(resolved)) {
        throw new ToolRuntimeError(
          'output_too_large',
          `at most ${MAX_PENDING_WRITES} chunked writes may be open at once`,
        );
      }
      this.#pendingWrites.set(resolved, pending);
      return { value: { written: bytes, done: false }, target: relative };
    }
    this.#pendingWrites.delete(resolved);
    const text = pending.parts.join('');
    try {
      host.fs.writeFileSync(resolved, text);
    } catch (error) {
      throw this.#ioError(error, `fs.write: ${relative}`);
    }
    // A later `fs.read` in the same call must not see the cached pre-write text.
    if (this.#readCache?.path === resolved) this.#readCache = undefined;
    return { value: { written: pending.bytes, done: true }, target: relative };
  }

  #list(payload: Record<string, unknown>): HandlerResult {
    const host = this.#options.host;
    const relative = assertListable(
      stringField(payload, 'path'),
      this.#capabilities,
      this.#workspace,
    );
    const label = relative === '' ? '.' : relative;
    const resolved =
      relative === '' ? host.path.resolve(this.#workspace) : host.path.resolve(this.#workspace, relative);
    const stat = this.#stat(resolved, `fs.list: ${label}`);
    if (!stat.isDirectory()) {
      throw new ToolRuntimeError('invalid_arguments', `fs.list expects a directory: ${label}`);
    }
    let children;
    try {
      children = host.fs.readdirSync(resolved);
    } catch (error) {
      throw this.#ioError(error, `fs.list: ${label}`);
    }
    const entries: FsEntry[] = [];
    const read = this.#capabilities.fs.read;
    for (const child of children) {
      if (isDeniedSegmentName(child.name) || isDeniedFileName(child.name)) continue;
      const childPath = relative === '' ? child.name : `${relative}/${child.name}`;
      // S1: an entry is listed only when a grant covers it, exactly as `fs.glob`
      // filters its results. S2: a recursive grant covers the directory itself.
      if (!isGrantedPath(childPath, read) && !isGrantedDirectory(childPath, read)) continue;
      // M3: a link onto `.git` or `.env` is denied on its real target.
      if (isDeniedRealPath(host.path.join(resolved, child.name), this.#workspace)) continue;
      let kind: FsEntry['kind'] | undefined;
      if (child.isFile()) kind = 'file';
      else if (child.isDirectory()) kind = 'directory';
      else if (child.isSymbolicLink()) kind = this.#linkedKind(host.path.join(resolved, child.name));
      if (kind === undefined) continue;
      entries.push({ name: child.name, path: childPath, kind });
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return { value: entries, target: label };
  }

  #glob(payload: Record<string, unknown>): HandlerResult {
    const pattern = assertGlobPattern(stringField(payload, 'pattern'));
    const matcher = globToRegExp(pattern);
    const matched = this.#walkFiles()
      .filter((file) => matcher.test(file))
      .sort();
    const allowed = filterGlobResults(matched, this.#capabilities, this.#workspace);
    const truncated = allowed.length > SANDBOX_MAX_GLOB_RESULTS;
    const kept = truncated ? allowed.slice(0, SANDBOX_MAX_GLOB_RESULTS) : allowed;
    if (truncated) {
      this.#options.audit.allow('log', `fs.glob:${SANDBOX_MAX_GLOB_RESULTS}`);
    }
    return { value: kept, target: pattern };
  }

  #grep(payload: Record<string, unknown>): HandlerResult {
    const pattern = stringField(payload, 'pattern');
    if (pattern.length === 0 || pattern.length > MAX_GREP_PATTERN) {
      throw new ToolRuntimeError(
        'invalid_arguments',
        `fs.grep patterns are 1-${MAX_GREP_PATTERN} characters`,
      );
    }
    const options = optionalRecord(payload.options, 'fs.grep options');
    // n3: an unknown key used to be dropped silently, so `{ path: '.git' }`
    // searched the whole workspace instead of being refused.
    for (const key of Object.keys(options)) {
      if (!GREP_OPTION_KEYS.includes(key)) {
        throw new ToolRuntimeError(
          'invalid_arguments',
          `fs.grep options.${key} is not supported (${GREP_OPTION_KEYS.join(', ')})`,
        );
      }
    }
    if (options.glob !== undefined && typeof options.glob !== 'string') {
      throw new ToolRuntimeError('invalid_arguments', 'fs.grep options.glob must be a string');
    }
    if (options.ignoreCase !== undefined && typeof options.ignoreCase !== 'boolean') {
      throw new ToolRuntimeError('invalid_arguments', 'fs.grep options.ignoreCase must be a boolean');
    }
    const glob = options.glob === undefined ? undefined : assertGlobPattern(options.glob);
    const ignoreCase = options.ignoreCase === true;
    let matcher: RegExp;
    try {
      matcher = new RegExp(pattern, ignoreCase ? 'i' : '');
    } catch {
      throw new ToolRuntimeError(
        'invalid_arguments',
        'fs.grep pattern is not a valid regular expression',
      );
    }
    const globMatcher = glob === undefined ? undefined : globToRegExp(glob);
    const candidates = filterGlobResults(this.#walkFiles(), this.#capabilities, this.#workspace)
      .filter((file) => globMatcher === undefined || globMatcher.test(file))
      .sort();
    const host = this.#options.host;
    const matches: GrepMatch[] = [];
    for (const relative of candidates) {
      if (matches.length >= SANDBOX_MAX_GREP_MATCHES) break;
      const resolved = host.path.resolve(this.#workspace, relative);
      let stat;
      try {
        stat = host.fs.statSync(resolved);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > SANDBOX_MAX_READ_BYTES) continue;
      let text: string;
      try {
        text = host.fs.readFileSync(resolved);
      } catch {
        continue;
      }
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (!matcher.test(line)) continue;
        matches.push({ path: relative, line: index + 1, text: line });
        if (matches.length >= SANDBOX_MAX_GREP_MATCHES) break;
      }
    }
    return { value: matches, target: pattern };
  }

  #process(payload: Record<string, unknown>): HandlerResult {
    const host = this.#options.host;
    const argv = payload.argv;
    const env = payload.env === undefined ? undefined : stringRecord(payload.env, 'process.run env');
    if (env !== undefined && Object.keys(env).length > MAX_ENV_ENTRIES) {
      throw new ToolRuntimeError(
        'invalid_arguments',
        `process.run env is limited to ${MAX_ENV_ENTRIES} entries`,
      );
    }
    assertProcessArgv(argv, this.#capabilities, { env });
    const program = argv[0] ?? '';
    const target = host.path.basename(program) || 'process.run';
    const cwd =
      payload.cwd === undefined
        ? host.path.resolve(this.#workspace)
        : assertWorkspaceDirectory(stringField(payload, 'cwd'), this.#workspace);
    const stdin = payload.stdin === undefined ? undefined : stringField(payload, 'stdin');
    const merged: Record<string, string> = { ...this.#options.process.env, ...(env ?? {}) };
    const remaining = Math.max(1, this.#options.deadline - this.#options.now());
    const timeout = Math.min(remaining, this.#options.process.timeoutMs ?? remaining);
    const cap = this.#options.process.maxOutputBytes;
    let stdout: string;
    try {
      stdout = host.childProcess.execFileSync(program, argv.slice(1), {
        cwd,
        env: merged,
        timeout,
        maxBuffer: cap + 64 * 1024,
        stdin,
      });
    } catch (error) {
      return this.#processFailure(error, target);
    }
    if (this.#options.signal?.aborted === true) {
      throw new ToolRuntimeError('time_limit', 'the call was aborted by the caller');
    }
    if (Buffer.byteLength(stdout, 'utf8') > cap) {
      throw new ToolRuntimeError('output_too_large', `process.run output is limited to ${cap} bytes`);
    }
    const value: ProcessRunResult = { code: 0, stdout, stderr: '' };
    return { value, target };
  }

  /**
   * Turn a synchronous child-process error into a result or a runtime error.
   * A non-zero exit code is a normal result; only spawn and timeout failures
   * become errors.
   */
  #processFailure(error: unknown, target: string): HandlerResult {
    const detail = error as HostExecError;
    const code = typeof detail.code === 'string' ? detail.code : undefined;
    // ENOBUFS is checked first: Node kills the child when its buffer overflows,
    // so the error also carries SIGTERM and would look like a timeout.
    if (code === 'ENOBUFS') {
      throw new ToolRuntimeError(
        'output_too_large',
        `process.run output is limited to ${this.#options.process.maxOutputBytes} bytes`,
      );
    }
    if (code === 'ETIMEDOUT' || detail.signal === 'SIGTERM' || detail.signal === 'SIGKILL') {
      throw new ToolRuntimeError('process_timeout', 'the child process exceeded its time budget');
    }
    if (code === 'ENOENT') {
      throw new ToolRuntimeError('process_failed', `process.run could not start "${target}"`);
    }
    if (typeof detail.status === 'number') {
      const value: ProcessRunResult = {
        code: detail.status,
        stdout: textOf(detail.stdout),
        stderr: textOf(detail.stderr),
      };
      return { value, target };
    }
    throw new ToolRuntimeError('process_failed', `process.run failed to start "${target}"`);
  }

  #log(payload: Record<string, unknown>): HandlerResult {
    const level = payload.level;
    if (typeof level !== 'string' || !(LOG_LEVELS as readonly string[]).includes(level)) {
      throw new ToolRuntimeError(
        'invalid_arguments',
        'log level must be debug, info, warn or error',
      );
    }
    const message = stringField(payload, 'message');
    const capped =
      message.length > MAX_LOG_MESSAGE ? `${message.slice(0, MAX_LOG_MESSAGE)}...` : message;
    this.#options.onLog?.(level as LogLevel, capped);
    return { value: null, target: 'log' };
  }

  /** Walk the workspace for glob and grep: files only, no symlinks, no denials. */
  #walkFiles(): string[] {
    const host = this.#options.host;
    const root = host.path.resolve(this.#workspace);
    const files: string[] = [];
    const visit = (absolute: string, prefix: string, depth: number): void => {
      if (depth > MAX_WALK_DEPTH) return;
      let entries;
      try {
        entries = host.fs.readdirSync(absolute);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (isDeniedSegmentName(entry.name) || isDeniedFileName(entry.name)) continue;
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          visit(host.path.join(absolute, entry.name), relative, depth + 1);
        } else if (entry.isFile()) {
          files.push(relative);
        }
      }
    };
    visit(root, '', 0);
    return files;
  }

  #linkedKind(absolute: string): FsEntry['kind'] | undefined {
    const host = this.#options.host;
    try {
      const real = host.fs.realpathSync(absolute);
      const root = host.fs.realpathSync(host.path.resolve(this.#workspace));
      const relative = host.path.relative(root, real);
      if (relative.startsWith('..') || host.path.isAbsolute(relative)) return undefined;
      const stat = host.fs.statSync(real);
      if (stat.isFile()) return 'file';
      if (stat.isDirectory()) return 'directory';
    } catch {
      return undefined;
    }
    return undefined;
  }

  #stat(resolved: string, label: string): ReturnType<RuntimeHost['fs']['statSync']> {
    try {
      return this.#options.host.fs.statSync(resolved);
    } catch (error) {
      throw this.#ioError(error, label);
    }
  }

  /** The file text, cached between the chunks of one read. */
  #cachedText(resolved: string, relative: string): string {
    const cached = this.#readCache;
    if (cached !== undefined && cached.path === resolved) return cached.text;
    const text = this.#readFile(resolved, `fs.read: ${relative}`);
    this.#readCache = { path: resolved, text };
    return text;
  }

  #readFile(resolved: string, label: string): string {
    try {
      return this.#options.host.fs.readFileSync(resolved);
    } catch (error) {
      throw this.#ioError(error, label);
    }
  }

  /** Map an fs error onto a code without ever echoing an absolute host path. */
  #ioError(error: unknown, label: string): ToolRuntimeError {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT') {
      return new ToolRuntimeError('invalid_arguments', `${label}: no such file or directory`);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return new ToolRuntimeError('path_denied', `${label}: permission denied`);
    }
    if (code === 'EISDIR') {
      return new ToolRuntimeError('invalid_arguments', `${label}: is a directory`);
    }
    if (code === 'ENOTDIR') {
      return new ToolRuntimeError('invalid_arguments', `${label}: not a directory`);
    }
    this.#options.warn?.(`z1 runtime: ${label} failed: ${describeError(error)}`);
    return new ToolRuntimeError('invalid_arguments', `${label}: the file operation failed`);
  }

  #asRuntimeError(error: unknown): ToolRuntimeError {
    if (error instanceof ToolRuntimeError) return error;
    this.#options.warn?.(`z1 runtime: unexpected broker failure: ${describeError(error)}`);
    return new ToolRuntimeError('tool_threw', 'the sandbox broker failed');
  }

  #ensureBudget(): void {
    if (this.#options.signal?.aborted === true) {
      throw new ToolRuntimeError('time_limit', 'the call was aborted by the caller');
    }
    if (this.#options.now() >= this.#options.deadline) {
      throw new ToolRuntimeError(
        'time_limit',
        `the call exceeded its ${this.#options.budgetMs} ms time budget`,
      );
    }
  }

  /** Best-effort audit target from the raw payload; never an absolute path. */
  #targetOf(kind: string, payloadJson: string): string {
    if (typeof payloadJson !== 'string' || Buffer.byteLength(payloadJson, 'utf8') > SANDBOX_MAX_BRIDGE_BYTES) {
      return kind;
    }
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(payloadJson);
      payload = isRecord(parsed) ? parsed : {};
    } catch {
      return kind;
    }
    if (kind === 'log') return 'log';
    if (kind === 'process.run') {
      const argv = payload.argv;
      if (Array.isArray(argv) && typeof argv[0] === 'string') {
        return this.#options.host.path.basename(argv[0]) || 'process.run';
      }
      return 'process.run';
    }
    const value = kind === 'fs.glob' || kind === 'fs.grep' ? payload.pattern : payload.path;
    return typeof value === 'string' && isAuditableTarget(value) ? value : kind;
  }

  get #capabilities() {
    return this.#options.manifest.capabilities;
  }

  get #workspace(): string {
    return this.#options.workspace;
  }
}

/**
 * S4/n2: no single string may cross the bridge above the cap. The shim chunks
 * reads, writes and the result envelope, so hitting this means a caller builds
 * its own payload.
 */
function assertBridgeCall(kind: unknown, payloadJson: unknown): void {
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new ToolRuntimeError('invalid_arguments', 'the bridge kind must be a non-empty string');
  }
  if (typeof payloadJson !== 'string') {
    throw new ToolRuntimeError('invalid_arguments', 'the bridge payload must be a JSON string');
  }
  const bytes = Buffer.byteLength(payloadJson, 'utf8');
  if (bytes > SANDBOX_MAX_BRIDGE_BYTES) {
    throw new ToolRuntimeError(
      'invalid_arguments',
      `bridge payloads are limited to ${SANDBOX_MAX_BRIDGE_BYTES} bytes, this one is ${bytes}`,
    );
  }
}

/**
 * One `fs.read` reply: `{ data, next }`, where `next` is the code-unit offset to
 * continue from, or `null` at EOF. `size` shrinks until the serialized reply fits
 * the bridge cap, so escaped content (quotes, control characters) cannot inflate
 * a single crossing past it.
 */
function readChunk(text: string, offset: number, length: number): { data: string; next: number | null } {
  let size = Math.max(1, Math.min(length, text.length - offset));
  let data = '';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    data = text.slice(offset, offset + size);
    const next = offset + size < text.length ? offset + size : null;
    const bytes = Buffer.byteLength(JSON.stringify({ ok: true, value: { data, next } }), 'utf8');
    if (bytes <= SANDBOX_MAX_BRIDGE_BYTES || size <= 1) break;
    const scaled = Math.floor((size * SANDBOX_MAX_BRIDGE_BYTES) / bytes);
    size = Math.max(1, Math.min(size - 1, scaled));
  }
  const next = offset + size < text.length ? offset + size : null;
  return { data, next };
}

function parsePayload(payloadJson: string): Record<string, unknown> {
  if (typeof payloadJson !== 'string') {
    throw new ToolRuntimeError('invalid_arguments', 'bridge payload must be a JSON string');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new ToolRuntimeError('invalid_arguments', 'bridge payload is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw new ToolRuntimeError('invalid_arguments', 'bridge payload must be a JSON object');
  }
  return parsed;
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string') {
    throw new ToolRuntimeError('invalid_arguments', `${key} must be a string`);
  }
  return value;
}

function integerField(payload: Record<string, unknown>, key: string, fallback: number): number {
  const value = payload[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolRuntimeError('invalid_arguments', `fs.read/write ${key} must be an integer`);
  }
  return value;
}

function booleanField(payload: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = payload[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new ToolRuntimeError('invalid_arguments', `fs.write ${key} must be a boolean`);
  }
  return value;
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new ToolRuntimeError('invalid_arguments', `${label} must be an object`);
  }
  return value;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new ToolRuntimeError('invalid_arguments', `${label} must be an object of strings`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw new ToolRuntimeError('invalid_arguments', `${label}.${key} must be a string`);
    }
    out[key] = item;
  }
  return out;
}

/** A target is auditable when it cannot name an absolute host path. */
function isAuditableTarget(value: string): boolean {
  if (value.length === 0 || value.length > 1024) return false;
  if (value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:/.test(value)) return false;
  return !value.split('/').includes('..');
}

function textOf(value: string | Buffer | undefined): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : value.toString('utf8');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
