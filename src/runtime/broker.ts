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
import { relayFetch } from './fetch.js';
import type { NetRelayResult } from './fetch.js';
import type { HostExecError, RuntimeHost } from './host.js';
import {
  SANDBOX_MAX_BRIDGE_BYTES,
  SANDBOX_MAX_GLOB_RESULTS,
  SANDBOX_MAX_GREP_MATCHES,
  SANDBOX_MAX_NET_REDIRECTS,
  SANDBOX_MAX_NET_REQUEST_BYTES,
  SANDBOX_MAX_READ_BYTES,
} from './limits.js';
import {
  assertEnvNames,
  assertFetchHeaders,
  assertFetchMethod,
  assertFetchUrl,
  assertGlobPattern,
  assertListable,
  assertProcessArgv,
  assertReadable,
  assertWritable,
  assertWorkspaceDirectory,
  filterGlobResults,
  hostAllowed,
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
/** Body bytes requested per `net.fetch` chunk: the same 1/8 bridge slice `fs.read` uses. */
const NET_CHUNK_BYTES = SANDBOX_MAX_BRIDGE_BYTES / 8;
/** Secrets shorter than this are not masked: a two-letter value would eat the log. */
const MIN_SECRET_LENGTH = 8;
/** Longest `env.read` audit target; a longer list is summarized as a count. */
const MAX_ENV_AUDIT_TARGET = 512;
const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];

export interface BrokerProcessOptions {
  /** Base environment for children. */
  readonly env: Record<string, string>;
  readonly timeoutMs: number | undefined;
  readonly maxOutputBytes: number;
}

/**
 * The host's network ceiling, as `createToolRuntime({ net })` resolved it.
 *
 * `enabled: false` is `net: false`: every `net.fetch` fails with `net_disabled`
 * whatever the manifest declares. `hosts` is the optional extra list: a URL host
 * must be covered by the manifest **and** by this one.
 */
export interface BrokerNetOptions {
  readonly enabled: boolean;
  readonly hosts: readonly string[] | undefined;
}

/** The resolved secret values the manifest declares; never sent to the audit. */
export interface BrokerEnvOptions {
  readonly values: Record<string, string>;
}

export interface BrokerOptions {
  readonly workspace: string;
  /** Absolute runtime directories a tool must never write into. */
  readonly protectedRoots?: readonly string[] | undefined;
  readonly manifest: ToolManifest;
  readonly audit: AuditCollector;
  readonly now: () => number;
  readonly deadline: number;
  readonly budgetMs: number;
  readonly maxOutputBytes: number;
  readonly process: BrokerProcessOptions;
  readonly net: BrokerNetOptions;
  readonly env: BrokerEnvOptions;
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
  /** The response body of the last `net.fetch`, between its chunks. */
  #netCache: { readonly url: string; readonly body: string } | undefined;
  /** Resolved secret values, longest first; built once per broker. */
  #secrets: readonly string[] | undefined;

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
      this.#options.audit.deny(kind, runtimeError.code, this.#deniedTarget(kind, target, runtimeError.code));
      throw runtimeError;
    }
  }

  /**
   * What a denial row records. A secret-path denial never records the name it
   * refused, and a `net.fetch` denial never records the URL: the query string of
   * a refused request can hold exactly the credential the tool was not allowed
   * to send. Everything else keeps its path, argv[0] basename or pattern.
   */
  #deniedTarget(kind: string, target: string, code: string): string {
    if (code === 'secret_path_denied' || kind === 'net.fetch') return '<redacted>';
    return target;
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
        return this.#fetch(payload);
      case 'env.read':
        return this.#env();
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
      { protectedRoots: this.#protectedRoots },
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
    // A tool that logs a secret it was granted must not put it in a log file:
    // every resolved value of 8+ characters is replaced before it leaves here.
    this.#options.onLog?.(level as LogLevel, this.#mask(capped));
    return { value: null, target: 'log' };
  }

  /**
   * `ctx.net.fetch`: validate, follow redirects one hop at a time, relay the
   * final body back in chunks.
   *
   * The body is **not** returned whole: it is cached here and the shim pulls it
   * with `{ offset }` calls, the same `next` cursor `fs.read` uses, because a
   * multi-megabyte string crossing the bridge in one call is what makes the
   * QuickJS teardown abort (see `SECURITY.md`).
   */
  #fetch(payload: Record<string, unknown>): HandlerResult {
    if (!this.#options.net.enabled) {
      throw new ToolRuntimeError(
        'net_disabled',
        'net.fetch is disabled for this runtime; the host passed net: false',
      );
    }
    if (payload.offset !== undefined) return this.#fetchChunk(payload);

    const method = assertFetchMethod(payload.method);
    const headers = assertFetchHeaders(payload.headers);
    const body = this.#requestBody(payload);
    const sendsBody = method !== 'GET' && method !== 'HEAD';

    let current = this.#assertHop(stringField(payload, 'url'), 'net.fetch');
    let currentMethod = method;
    let currentHeaders = headers;
    let currentBody = sendsBody ? body : undefined;

    for (let hop = 0; hop <= SANDBOX_MAX_NET_REDIRECTS; hop += 1) {
      this.#ensureBudget();
      const relayed = relayFetch(this.#options.host, {
        url: current.toString(),
        method: currentMethod,
        headers: currentHeaders,
        body: currentBody,
        remainingMs: this.#options.deadline - this.#options.now(),
      });
      if (!REDIRECT_STATUSES.includes(relayed.status) || relayed.location === null) {
        return this.#netResult(relayed, current.toString());
      }
      if (hop === SANDBOX_MAX_NET_REDIRECTS) {
        throw new ToolRuntimeError(
          'net_failed',
          `net.fetch followed more than ${SANDBOX_MAX_NET_REDIRECTS} redirects`,
        );
      }
      // Validate the hop *before* it is requested: a redirect to a denied host
      // is refused without a second socket, which is the whole point of
      // `redirect: 'manual'` in the helper.
      const next = this.#assertHop(
        this.#resolveLocation(relayed.location, current),
        'net.fetch redirect',
      );
      // 303 means "see other" and always becomes GET. 301/302 turn a POST into a
      // GET in every browser, and resending a form body to a different URL is
      // the kind of surprise a capability boundary must not allow. 307/308
      // exist precisely to keep method and body, so they do.
      if (
        relayed.status === 303 ||
        ((relayed.status === 301 || relayed.status === 302) && currentMethod === 'POST')
      ) {
        currentMethod = 'GET';
        currentBody = undefined;
        currentHeaders = dropEntityHeaders(currentHeaders);
      }
      current = next;
    }
    throw new ToolRuntimeError('net_failed', 'the redirect chain did not finish');
  }

  /**
   * Check one URL against both allow-lists: the manifest's `net.hosts` and, when
   * the host passed one, its own ceiling. Both must allow the host, so a host
   * that asked for less than the manifest cannot be talked out of it by a tool.
   */
  #assertHop(url: string, label: string): URL {
    const parsed = assertFetchUrl(url, this.#capabilities.net.hosts, label);
    const ceiling = this.#options.net.hosts;
    if (ceiling !== undefined && !hostAllowed(parsed.hostname, ceiling)) {
      throw new ToolRuntimeError(
        'net_denied',
        `${label} is not allowed to reach "${parsed.hostname}": the host ceiling does not list it`,
      );
    }
    return parsed;
  }

  /** Resolve a `Location` header against the hop that produced it. */
  #resolveLocation(location: string, base: URL): string {
    try {
      return new URL(location, base).toString();
    } catch {
      throw new ToolRuntimeError('net_failed', 'the redirect location is not a valid URL');
    }
  }

  /** The request body, capped, or `undefined` when the tool sent none. */
  #requestBody(payload: Record<string, unknown>): string | undefined {
    if (payload.body === undefined || payload.body === null) return undefined;
    const body = stringField(payload, 'body');
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > SANDBOX_MAX_NET_REQUEST_BYTES) {
      throw new ToolRuntimeError(
        'invalid_arguments',
        `net.fetch request bodies are limited to ${SANDBOX_MAX_NET_REQUEST_BYTES} bytes, this one is ${bytes}`,
      );
    }
    return body;
  }

  /** The first chunk of a finished response, plus the cursor for the rest. */
  #netResult(relayed: NetRelayResult, url: string): HandlerResult {
    const head = {
      ok: relayed.status >= 200 && relayed.status <= 299,
      status: relayed.status,
      statusText: relayed.statusText,
      url,
      headers: relayed.headers,
    };
    const chunk = netChunk(relayed.body, 0, NET_CHUNK_BYTES, (data, next) => ({
      ...head,
      data,
      next,
    }));
    // Keep the body between chunks only while there is something left to pull.
    this.#netCache = chunk.next === null ? undefined : { url, body: relayed.body };
    return { value: { ...head, data: chunk.data, next: chunk.next }, target: url };
  }

  /** One follow-up chunk of the cached response body. */
  #fetchChunk(payload: Record<string, unknown>): HandlerResult {
    const cached = this.#netCache;
    if (cached === undefined) {
      throw new ToolRuntimeError(
        'invalid_arguments',
        'net.fetch has no response body to continue; start the request without an offset',
      );
    }
    const offset = payload.offset;
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset <= 0) {
      throw new ToolRuntimeError('invalid_arguments', 'net.fetch offset must be a positive integer');
    }
    if (offset > cached.body.length) {
      throw new ToolRuntimeError(
        'invalid_arguments',
        `net.fetch offset ${offset} is past the end of the response body`,
      );
    }
    const chunk = netChunk(cached.body, offset, NET_CHUNK_BYTES, (data, next) => ({ data, next }));
    if (chunk.next === null) this.#netCache = undefined;
    return { value: { data: chunk.data, next: chunk.next }, target: cached.url };
  }

  /**
   * `ctx.env`: the resolved values of the names the manifest declares, and
   * nothing else. An undeclared name is simply absent, so the VM-side object can
   * be frozen without leaving a hole a tool could fill.
   */
  #env(): HandlerResult {
    const values: Record<string, string> = {};
    const names: string[] = [];
    const source = this.#options.env.values;
    for (const name of this.#declaredEnv()) {
      const value = source[name];
      if (typeof value !== 'string') continue;
      // defineProperty, not assignment: a variable may legitimately be named
      // "__proto__", and `values['__proto__'] = x` would reach the prototype.
      Object.defineProperty(values, name, {
        value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
      names.push(name);
    }
    return { value: { values }, target: envTarget(names) };
  }

  /** The manifest's `env.read`, validated: exact names only, never `'*'`. */
  #declaredEnv(): string[] {
    // A hand-written `tool.json` may omit `env` entirely (the manifest check
    // tolerates it), so the read is defensive even though the type says it is
    // there; a wildcard in a hand-edited manifest is refused here, per call.
    return assertEnvNames(this.#capabilities.env?.read);
  }

  /** Every resolved value a log line or a message must not carry. */
  get #secretValues(): readonly string[] {
    this.#secrets ??= [
      ...new Set(
        Object.values(this.#options.env.values).filter(
          (value) => typeof value === 'string' && value.length >= MIN_SECRET_LENGTH,
        ),
      ),
    ].sort((left, right) => right.length - left.length);
    return this.#secrets;
  }

  /** Replace every resolved secret value of 8+ characters with `[redacted]`. */
  #mask(text: string): string {
    let masked = text;
    for (const secret of this.#secretValues) {
      if (masked.includes(secret)) masked = masked.split(secret).join('[redacted]');
    }
    return masked;
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
    if (error instanceof ToolRuntimeError) {
      // A refusal can name what the tool sent (a pattern, an option key, a
      // header). None of it may carry a granted secret back to the VM or into
      // the host log, so the message is masked once, here.
      const masked = this.#mask(error.message);
      if (masked === error.message) return error;
      return new ToolRuntimeError(error.code, masked, {
        ...(error.tool === undefined ? {} : { tool: error.tool }),
        ...(error.details === undefined ? {} : { details: error.details }),
        cause: error,
      });
    }
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
    if (kind === 'env.read') return 'env.read';
    if (kind === 'net.fetch') {
      // Chunk pulls carry an offset, not a URL; the allow row of the request
      // itself has the URL and the follow-up chunks reuse it.
      if (typeof payload.offset === 'number') return this.#netCache?.url ?? 'net.fetch';
      const url = payload.url;
      return typeof url === 'string' && isAuditableTarget(url) ? url : 'net.fetch';
    }
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

  get #protectedRoots(): readonly string[] | undefined {
    return this.#options.protectedRoots;
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

/**
 * One chunk of a response body, shrunk until the serialized reply fits the
 * bridge cap — the same discipline as {@link readChunk}, because `net.fetch`
 * replies cross the same bridge and the body is the only large field.
 */
function netChunk(
  body: string,
  offset: number,
  length: number,
  envelope: (data: string, next: number | null) => unknown,
): { data: string; next: number | null } {
  let size = Math.max(0, Math.min(length, body.length - offset));
  let data = '';
  let next: number | null = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    data = body.slice(offset, offset + size);
    next = offset + size < body.length ? offset + size : null;
    const bytes = Buffer.byteLength(
      JSON.stringify({ ok: true, value: envelope(data, next) }),
      'utf8',
    );
    if (bytes <= SANDBOX_MAX_BRIDGE_BYTES || size <= 1) break;
    const scaled = Math.floor((size * SANDBOX_MAX_BRIDGE_BYTES) / bytes);
    size = Math.max(1, Math.min(size - 1, scaled));
  }
  data = body.slice(offset, offset + size);
  next = offset + size < body.length ? offset + size : null;
  return { data, next };
}

/** A redirect that becomes a GET must not keep the body's content type. */
function dropEntityHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'content-type') continue;
    out[name] = value;
  }
  return out;
}

/** The `env.read` audit target: the names, never a value, never unbounded. */
function envTarget(names: readonly string[]): string {
  if (names.length === 0) return 'env.read';
  const joined = names.join(',');
  return joined.length <= MAX_ENV_AUDIT_TARGET ? joined : `${names.length} names`;
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
