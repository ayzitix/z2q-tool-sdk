import {
  assertFetchUrl,
  assertProcessOptions,
  globToRegExp,
  normalizeGlobPattern,
  normalizeGrepOptions,
  resolveToolPath,
  workspaceRelativePath,
} from './context.js';
import type {
  FsEntry,
  GrepMatch,
  GrepOptions,
  LogLevel,
  NetFetchInit,
  NetFetchResult,
  ProcessRunResult,
  ToolContext,
} from './types.js';

export interface TestCommandCall {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

export interface TestCommandResult {
  code?: number;
  stdout?: string;
  stderr?: string;
}

export type TestCommandHandler = (
  call: TestCommandCall,
) => TestCommandResult | Promise<TestCommandResult>;

export interface TestCommandRule {
  /** Exact argv to match. Never a shell string. */
  argv: string[];
  handler: TestCommandHandler;
}

export interface TestFetchCall {
  url: string;
  init?: NetFetchInit;
}

export interface TestFetchResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

export type TestFetchHandler = (
  call: TestFetchCall,
) => TestFetchResponse | Promise<TestFetchResponse>;

export interface TestFetchRule {
  /** Exact URL string or a RegExp tested against the full URL. */
  url: string | RegExp;
  handler: TestFetchHandler;
}

export type RecordedCall =
  | { kind: 'fs.read'; path: string }
  | { kind: 'fs.write'; path: string; data: string }
  | { kind: 'fs.list'; path: string }
  | { kind: 'fs.glob'; pattern: string }
  | { kind: 'fs.grep'; pattern: string; glob?: string; ignoreCase?: boolean }
  | {
      kind: 'process.run';
      argv: string[];
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
    }
  | { kind: 'net.fetch'; url: string; init?: NetFetchInit }
  | { kind: 'log'; level: LogLevel; message: string };

export interface TestContextOptions {
  /** Absolute workspace root. Defaults to the virtual `/test-workspace`. */
  workspace?: string;
  /** Initial in-memory files. Passing this object enables `ctx.fs`. */
  files?: Record<string, string>;
  /** Command handlers. Passing this array enables `ctx.process`. */
  commands?: TestCommandRule[];
  /** Fetch handlers. Passing this array enables `ctx.net`. */
  fetches?: TestFetchRule[];
  signal?: AbortSignal;
}

/**
 * An in-memory `ToolContext` for tests. Capabilities are opt-in: `ctx.fs` only
 * works when `files` is passed, `ctx.process` only when `commands` is passed,
 * and `ctx.net` only when `fetches` is passed. Everything else throws a clear
 * error instead of accidentally succeeding.
 */
export interface TestContext extends ToolContext {
  /** Every fs/process/net/log call, in order. */
  readonly calls: RecordedCall[];
  /** Snapshot of the current in-memory files, keyed by workspace-relative path. */
  files(): Record<string, string>;
  /** Clear the recorder and restore the initial files. */
  reset(): void;
}

const DEFAULT_WORKSPACE = '/test-workspace';
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function createTestContext(options: TestContextOptions = {}): TestContext {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('createTestContext options must be an object');
  }
  const workspace =
    options.workspace === undefined
      ? DEFAULT_WORKSPACE
      : resolveToolPath(options.workspace, '.');

  const fsEnabled = options.files !== undefined;
  const processEnabled = options.commands !== undefined;
  const netEnabled = options.fetches !== undefined;

  const initial = new Map<string, string>();
  if (options.files !== undefined) {
    for (const [path, contents] of Object.entries(options.files)) {
      if (typeof contents !== 'string') {
        throw new TypeError(`files["${path}"] must be a string`);
      }
      const relative = workspaceRelativePath(workspace, resolveToolPath(workspace, path));
      if (relative === '.') {
        throw new TypeError('files keys must point at files, not the workspace root');
      }
      initial.set(relative, contents);
    }
  }

  const commands = options.commands ?? [];
  for (const [index, rule] of commands.entries()) {
    if (typeof rule !== 'object' || rule === null || typeof rule.handler !== 'function') {
      throw new TypeError(`commands[${index}] must be { argv, handler }`);
    }
    assertProcessOptions({ argv: rule.argv });
  }

  const fetches = options.fetches ?? [];
  for (const [index, rule] of fetches.entries()) {
    if (typeof rule !== 'object' || rule === null || typeof rule.handler !== 'function') {
      throw new TypeError(`fetches[${index}] must be { url, handler }`);
    }
    if (typeof rule.url === 'string') {
      assertFetchUrl(rule.url);
    } else if (!(rule.url instanceof RegExp)) {
      throw new TypeError(`fetches[${index}].url must be a string or RegExp`);
    }
  }

  const signal = options.signal ?? new AbortController().signal;
  const files = new Map(initial);
  const calls: RecordedCall[] = [];

  const assertNotAborted = (): void => {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('tool context aborted');
    }
  };

  const requireFs = (operation: string): void => {
    if (!fsEnabled) {
      throw new Error(
        `fs.${operation} is not available in this test context; pass options.files to enable the in-memory filesystem`,
      );
    }
  };

  const relativePath = (path: string): string =>
    workspaceRelativePath(workspace, resolveToolPath(workspace, path));

  const read = async (path: string): Promise<string> => {
    const relative = relativePath(path);
    calls.push({ kind: 'fs.read', path: relative });
    requireFs('read');
    assertNotAborted();
    const contents = files.get(relative);
    if (contents === undefined) {
      throw new Error(`ENOENT: no such file in the test workspace: ${relative}`);
    }
    return contents;
  };

  const write = async (path: string, data: string): Promise<void> => {
    const relative = relativePath(path);
    if (typeof data !== 'string') {
      throw new TypeError('fs.write data must be a string');
    }
    calls.push({ kind: 'fs.write', path: relative, data });
    requireFs('write');
    assertNotAborted();
    files.set(relative, data);
  };

  const list = async (path: string): Promise<FsEntry[]> => {
    const relative = relativePath(path);
    calls.push({ kind: 'fs.list', path: relative });
    requireFs('list');
    assertNotAborted();
    if (files.has(relative)) {
      throw new Error(`not a directory: ${relative}`);
    }
    const prefix = relative === '.' ? '' : `${relative}/`;
    if (relative !== '.' && ![...files.keys()].some((key) => key.startsWith(prefix))) {
      throw new Error(`ENOENT: no such directory in the test workspace: ${relative}`);
    }
    const entries = new Map<string, FsEntry['kind']>();
    for (const key of files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf('/');
      entries.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1 ? 'file' : 'directory');
    }
    return [...entries.entries()]
      .map(([name, kind]) => ({ name, path: prefix + name, kind }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  };

  const glob = async (pattern: string): Promise<string[]> => {
    const normalized = normalizeGlobPattern(pattern);
    calls.push({ kind: 'fs.glob', pattern: normalized });
    requireFs('glob');
    assertNotAborted();
    const matcher = globToRegExp(normalized);
    return [...files.keys()].filter((key) => matcher.test(key)).sort();
  };

  const grep = async (pattern: string, grepOptions?: GrepOptions): Promise<GrepMatch[]> => {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new TypeError('fs.grep pattern must be a non-empty string');
    }
    const normalizedOptions = normalizeGrepOptions(grepOptions);
    calls.push({
      kind: 'fs.grep',
      pattern,
      glob: normalizedOptions.glob,
      ignoreCase: normalizedOptions.ignoreCase,
    });
    requireFs('grep');
    assertNotAborted();
    let matcher: RegExp;
    try {
      matcher = new RegExp(pattern, normalizedOptions.ignoreCase ? 'i' : '');
    } catch {
      throw new SyntaxError(`fs.grep pattern is not a valid regular expression: ${pattern}`);
    }
    const globMatcher =
      normalizedOptions.glob === undefined ? undefined : globToRegExp(normalizedOptions.glob);
    const candidates = [...files.keys()].filter(
      (key) => globMatcher === undefined || globMatcher.test(key),
    );
    const matches: GrepMatch[] = [];
    for (const path of candidates.sort()) {
      const text = files.get(path) ?? '';
      const lines = text.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (matcher.test(line)) {
          matches.push({ path, line: index + 1, text: line });
        }
      }
    }
    return matches;
  };

  const runProcess = async (runOptions: {
    argv: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
  }): Promise<ProcessRunResult> => {
    assertProcessOptions(runOptions);
    const call: TestCommandCall = {
      argv: [...runOptions.argv],
      cwd: runOptions.cwd,
      env: runOptions.env === undefined ? undefined : { ...runOptions.env },
      stdin: runOptions.stdin,
    };
    calls.push({
      kind: 'process.run',
      argv: [...runOptions.argv],
      cwd: runOptions.cwd,
      env: call.env,
      stdin: runOptions.stdin,
    });
    if (!processEnabled) {
      throw new Error(
        'process.run is not available in this test context; pass options.commands to enable command handlers',
      );
    }
    assertNotAborted();
    const rule = commands.find(
      (candidate) =>
        candidate.argv.length === runOptions.argv.length &&
        candidate.argv.every((arg, index) => arg === runOptions.argv[index]),
    );
    if (rule === undefined) {
      throw new Error(`no test command handler for argv: ${JSON.stringify(runOptions.argv)}`);
    }
    const result = await rule.handler(call);
    return normalizeCommandResult(result, runOptions.argv);
  };

  const fetchUrl = async (url: string, init?: NetFetchInit): Promise<NetFetchResult> => {
    assertFetchUrl(url);
    const call: TestFetchCall = {
      url,
      init: init === undefined ? undefined : { ...init, headers: init.headers ? { ...init.headers } : undefined },
    };
    calls.push({ kind: 'net.fetch', url, init: call.init });
    if (!netEnabled) {
      throw new Error(
        'net.fetch is not available in this test context; pass options.fetches to enable fetch handlers',
      );
    }
    assertNotAborted();
    const rule = fetches.find((candidate) => {
      if (typeof candidate.url === 'string') return candidate.url === url;
      candidate.url.lastIndex = 0;
      return candidate.url.test(url);
    });
    if (rule === undefined) {
      throw new Error(`no test fetch handler for url: ${url}`);
    }
    const response = await rule.handler(call);
    return normalizeFetchResponse(response, url);
  };

  const log = (level: LogLevel, message: string): void => {
    if (!LOG_LEVELS.includes(level)) {
      throw new TypeError(`invalid log level: ${String(level)}`);
    }
    if (typeof message !== 'string') {
      throw new TypeError('log message must be a string');
    }
    calls.push({ kind: 'log', level, message });
  };

  return {
    workspace,
    signal,
    fs: { read, write, list, glob, grep },
    process: { run: runProcess },
    net: { fetch: fetchUrl },
    log,
    calls,
    files: () => {
      const snapshot: Record<string, string> = {};
      for (const key of [...files.keys()].sort()) {
        snapshot[key] = files.get(key) ?? '';
      }
      return snapshot;
    },
    reset: () => {
      calls.length = 0;
      files.clear();
      for (const [key, value] of initial) files.set(key, value);
    },
  };
}

function normalizeCommandResult(result: TestCommandResult, argv: string[]): ProcessRunResult {
  if (typeof result !== 'object' || result === null) {
    throw new TypeError(`test command handler for ${JSON.stringify(argv)} must return an object`);
  }
  const code = result.code ?? 0;
  if (!Number.isInteger(code)) {
    throw new TypeError(`test command handler for ${JSON.stringify(argv)} returned a non-integer code`);
  }
  return {
    code,
    stdout: stringValue(result.stdout, 'stdout'),
    stderr: stringValue(result.stderr, 'stderr'),
  };
}

function normalizeFetchResponse(
  response: TestFetchResponse,
  url: string,
): NetFetchResult {
  if (typeof response !== 'object' || response === null) {
    throw new TypeError(`test fetch handler for ${url} must return an object`);
  }
  const status = response.status ?? 200;
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new TypeError(`test fetch handler for ${url} returned an invalid status`);
  }
  return {
    status,
    headers: response.headers === undefined ? {} : { ...response.headers },
    body: stringValue(response.body, 'body'),
  };
}

function stringValue(value: string | undefined, field: string): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    throw new TypeError(`test handler ${field} must be a string`);
  }
  return value;
}
