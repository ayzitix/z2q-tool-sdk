import { globToRegExp, normalizeGlobPattern } from '../context.js';
import type { ManifestCapabilities } from '../types.js';
import { ToolRuntimeError } from './errors.js';
import { hostNow, runtimeHost } from './host.js';
import {
  SANDBOX_MAX_ENV_ENTRIES,
  SANDBOX_MAX_NET_HEADERS,
} from './limits.js';

/**
 * The capability policy: pure, synchronous decisions about one workspace path,
 * glob or argv. Nothing here talks to QuickJS, so it is unit-tested directly.
 *
 * Two things are deliberately *not* in here: reading file contents and running
 * processes. The policy only decides; `broker.ts` performs the allowed action.
 */

const MAX_PATH_LENGTH = 1024;
const MAX_GLOB_PATTERN_LENGTH = 512;
const MAX_ARGV_ENTRIES = 256;
const MAX_ARGV_LENGTH = 8192;

/** Case-insensitive segments that are never reachable, at any depth. */
const DENIED_SEGMENTS = new Set([
  '.git',
  '.z1',
  '.z1-sessions',
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.svn',
  '.hg',
]);

/**
 * Segments that are readable but never writable, at any depth.
 *
 * A tool that overwrites a dependency is a tool that breaks the next call, and
 * when the workspace happens to be the SDK's own checkout it breaks the runtime
 * that is executing it. Reading stays allowed: inspecting a dependency does not
 * damage anything.
 */
const PROTECTED_WRITE_SEGMENTS = new Set(['node_modules']);

/**
 * Absolute directories owned by the runtime that is executing the tool: the CLI
 * checkout, the SDK checkout and the agent home. A tool must never write into
 * them — a broken runtime cannot be repaired by the agent that broke it.
 */
export interface PathPolicyOptions {
  readonly protectedRoots?: readonly string[] | undefined;
}

/** Case-insensitive file names and patterns that are never readable or writable. */
const DENIED_NAMES = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.keystore',
  '*.jks',
  'id_rsa*',
  'id_ed25519*',
  'id_ecdsa*',
  'credentials',
  '.netrc',
  '.npmrc',
  '.git-credentials',
] as const;

/** Environment variables a tool may never override for a child process. */
const DENIED_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'PYTHONPATH',
  'BASH_ENV',
  'ENV',
  'SHELL',
]);
const DENIED_ENV_PREFIXES = ['DYLD_', 'GIT_'] as const;

const DRIVE_PATTERN = /^[A-Za-z]:/;
const UNC_PATTERN = /^(?:\\\\|\/\/)[^\\/]/;

/**
 * Windows device names are not files. `CON`, `NUL`, `COM1` and friends address
 * the device even inside the workspace, so a segment equal to one is refused.
 */
const RESERVED_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

const NAME_PATTERNS: readonly { source: string; matcher: RegExp }[] = DENIED_NAMES.map(
  (source) => ({ source, matcher: namePatternToRegExp(source) }),
);

export interface ProcessArgvOptions {
  /** Extra environment for the child, checked for overrides. */
  env?: Record<string, string>;
}

/** Load the host modules the policy needs. Any async entry point calls this once. */
export async function ensurePolicyHost(): Promise<void> {
  await runtimeHost();
}

/**
 * Validate a path the tool wants to read and return it as a normalized,
 * workspace-relative, `/`-separated string.
 */
export function assertReadable(
  input: string,
  capabilities: ManifestCapabilities,
  workspace: string,
): string {
  const relative = assertSafeRelativePath(input, 'fs.read');
  assertInsideWorkspace(relative, workspace, 'fs.read');
  assertNotDenied(relative);
  assertGranted(relative, 'read', capabilities);
  return relative;
}

/**
 * Validate a directory the tool wants to list. Like {@link assertReadable}, but
 * `''` and `'.'` address the workspace root, which needs at least one `fs.read`
 * grant instead of a pattern match (no glob can express "the root itself").
 */
export function assertListable(
  input: string,
  capabilities: ManifestCapabilities,
  workspace: string,
): string {
  const relative = assertDirectoryPath(input, 'fs.list');
  assertInsideWorkspace(relative, workspace, 'fs.list');
  if (relative === '') {
    assertNotDenied('');
    if (capabilities.fs.read.length === 0) {
      throw refusal('capability_denied', 'listing the workspace root needs at least one fs.read grant');
    }
    return '';
  }
  assertNotDenied(relative);
  // S2: a recursive grant (`docs/**`) must be able to list `docs` itself, so a
  // directory is accepted when a grant matches it or anything beneath it.
  if (!isGrantedDirectory(relative, capabilities.fs.read)) {
    throw refusal('capability_denied', `no fs.read grant matches "${relative}"`);
  }
  return relative;
}

/**
 * Validate a write target and return it as a normalized relative path. The
 * parent must already exist inside the workspace, and a target that already
 * exists must not be a directory and must realpath inside the workspace.
 */
export function assertWritable(
  input: string,
  capabilities: ManifestCapabilities,
  workspace: string,
  options?: PathPolicyOptions,
): string {
  const host = hostNow();
  const relative = assertSafeRelativePath(input, 'fs.write');
  const resolved = assertInsideWorkspace(relative, workspace, 'fs.write');
  assertNotDenied(relative);
  assertGranted(relative, 'write', capabilities);
  assertNotProtected(relative, resolved, workspace, options);

  const parent = host.path.dirname(resolved);
  const root = host.path.resolve(workspace);
  if (!isInside(parent, root, host.caseInsensitive)) {
    throw refusal('path_outside_workspace', 'the parent directory is outside the workspace');
  }
  if (!host.fs.existsSync(parent) || !host.fs.statSync(parent).isDirectory()) {
    throw refusal(
      'path_outside_workspace',
      `the parent directory does not exist in the workspace: ${relative}`,
    );
  }
  if (host.fs.existsSync(resolved)) {
    if (host.fs.statSync(resolved).isDirectory()) {
      throw refusal('path_denied', `fs.write targets a directory: ${relative}`);
    }
    assertRealInside(resolved, workspace);
    assertDeniedReal(resolved, workspace);
  }
  return relative;
}

/** Validate a workspace-relative glob. Returns the normalized pattern. */
export function assertGlobPattern(pattern: string): string {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw refusal('invalid_arguments', 'fs.glob requires a non-empty pattern');
  }
  if (pattern.includes('\\')) {
    throw refusal('invalid_arguments', 'glob patterns use "/" separators, not "\\"');
  }
  if (pattern.length > MAX_GLOB_PATTERN_LENGTH) {
    throw refusal(
      'invalid_arguments',
      `glob patterns are limited to ${MAX_GLOB_PATTERN_LENGTH} characters`,
    );
  }
  try {
    return normalizeGlobPattern(pattern);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw refusal('path_outside_workspace', detail);
  }
}

/**
 * Drop glob results the tool is not allowed to see: denied segments and names,
 * paths without a read grant, and anything that resolves outside the workspace.
 */
export function filterGlobResults(
  paths: readonly string[],
  capabilities: ManifestCapabilities,
  workspace: string,
): string[] {
  const host = hostNow();
  const root = host.path.resolve(workspace);
  const kept: string[] = [];
  for (const candidate of paths) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    const relative = candidate.split('\\').join('/');
    const segments = relative.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      continue;
    }
    if (deniedSegment(segments) !== undefined || deniedName(relative) !== undefined) continue;
    if (!granted(capabilities.fs.read, relative)) continue;
    if (!isInside(host.path.resolve(root, relative), root, host.caseInsensitive)) continue;
    // M3: a result that links onto `.git` or `.env` is denied on its real path.
    if (isDeniedRealPath(host.path.resolve(root, relative), workspace)) continue;
    kept.push(relative);
  }
  return kept;
}

/**
 * Validate a `process.run` request: argv shape, the `argv[0]` grant, and the
 * environment overrides. `cwd` is a path question and goes through
 * {@link assertWorkspaceDirectory} instead.
 */
export function assertProcessArgv(
  argv: unknown,
  capabilities: ManifestCapabilities,
  options: ProcessArgvOptions = {},
): asserts argv is string[] {
  assertArgvShape(argv);
  const host = hostNow();
  const program = argv[0];
  if (program === undefined) {
    throw refusal('invalid_arguments', 'process.run requires argv[0]');
  }
  const name = host.path.basename(program);
  const allowed = capabilities.process.argv.some((grant) =>
    sameName(name, grant, host.caseInsensitive),
  );
  if (!allowed) {
    throw refusal('process_argv_denied', `process.run is not granted for "${name}"`);
  }
  if (options.env !== undefined) {
    if (typeof options.env !== 'object' || options.env === null || Array.isArray(options.env)) {
      throw refusal('invalid_arguments', 'process.run env must be an object of strings');
    }
    for (const [key, value] of Object.entries(options.env)) {
      if (typeof value !== 'string') {
        throw refusal('invalid_arguments', `process.run env.${key} must be a string`);
      }
      if (deniedEnvKey(key)) {
        throw refusal('process_argv_denied', `process.run may not override ${key}`);
      }
    }
  }
}

/**
 * Validate a `process.run` cwd (rules 1-5, no fs grant) and return the absolute
 * path. `''` and `'.'` mean the workspace root.
 */
export function assertWorkspaceDirectory(input: string, workspace: string): string {
  const host = hostNow();
  const relative = assertDirectoryPath(input, 'process.run cwd');
  const resolved = assertInsideWorkspace(relative, workspace, 'process.run cwd');
  if (relative !== '') assertNotDenied(relative);
  if (!host.fs.existsSync(resolved)) {
    throw refusal('path_outside_workspace', 'process.run cwd does not exist in the workspace');
  }
  if (!host.fs.statSync(resolved).isDirectory()) {
    throw refusal('invalid_arguments', 'process.run cwd must be a directory');
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Rules 11-13: the network, and rule 14: the environment
//
// These are the pure half of `ctx.net.fetch` and `ctx.env`: no socket, no
// `process.env`, no QuickJS. `broker.ts` decides with them and performs with
// the host modules, exactly like the filesystem rules above.
// ---------------------------------------------------------------------------

/** The seven methods the relay speaks; everything else is refused by name. */
const FETCH_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * Headers a tool may never set: they describe the connection the broker opens,
 * not the request the tool makes. A forged `host` reaches another virtual host
 * on the same address, `content-length` and `transfer-encoding` desynchronize
 * the body, and `connection`/`upgrade` would ask for a protocol switch.
 */
const DENIED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
]);

const MAX_URL_LENGTH = 2048;
const MAX_HEADER_NAME_LENGTH = 128;
const MAX_HEADER_VALUE_LENGTH = 4096;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * True when `host` is covered by `allow`.
 *
 * Matching is case-insensitive and a trailing dot (the DNS root) is ignored, so
 * `API.Example.com.` matches `api.example.com`. `'*'` covers everything, which
 * is what a host that asked for full network access declares. `'*.example.com'`
 * covers `example.com` itself **and** every subdomain: a tool allowed the whole
 * wildcard has no reason to be refused the apex, and refusing it would only
 * produce a confusing half-allowance. Everything else is an exact match, so an
 * IP literal is reachable only when it is listed verbatim (or through `'*'`),
 * never through a wildcard and never through a lookalike name.
 */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const target = normalizeHost(host);
  if (target.length === 0) return false;
  for (const entry of allow) {
    if (typeof entry !== 'string') continue;
    const pattern = normalizeHost(entry);
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) {
      // `*.example.com` -> suffix `.example.com`, apex `example.com`.
      if (target === pattern.slice(2) || target.endsWith(pattern.slice(1))) return true;
      continue;
    }
    if (pattern === target) return true;
  }
  return false;
}

/**
 * Validate one `net.fetch` URL against one allow-list and return it parsed.
 *
 * The check runs **per hop**, on the URL that is about to be requested, which
 * is why the broker calls it again for every redirect: a redirect is a request
 * to a host the tool never named. Anything that is not plain `http:`/`https:`
 * is refused before a socket exists — `file:`, `data:` and `ftp:` would reach a
 * different subsystem of the host. A URL carrying `user:pass@` is refused as
 * well: those credentials would either travel as an `Authorization` header the
 * audit cannot see, or be dropped silently, and both are surprises.
 */
export function assertFetchUrl(url: unknown, hosts: readonly string[], label: string): URL {
  if (typeof url !== 'string' || url.length === 0) {
    throw refusal('invalid_arguments', `${label} requires a URL string`);
  }
  if (url.length > MAX_URL_LENGTH) {
    throw refusal('invalid_arguments', `${label} URLs are limited to ${MAX_URL_LENGTH} characters`);
  }
  if (url.includes('\0')) {
    throw refusal('invalid_arguments', `${label} URLs must not contain NUL bytes`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw refusal('invalid_arguments', `${label} requires an absolute http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw refusal(
      'invalid_arguments',
      `${label} only speaks http and https, not "${parsed.protocol.replace(':', '')}"`,
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw refusal('invalid_arguments', `${label} URLs must not embed credentials`);
  }
  const host = normalizeHost(parsed.hostname);
  if (host.length === 0) {
    throw refusal('invalid_arguments', `${label} requires a host`);
  }
  if (!hostAllowed(host, hosts)) {
    throw refusal('net_denied', `${label} is not allowed to reach "${host}"`);
  }
  return parsed;
}

/** Upper-case one method, defaulting to GET, and refuse anything unusual. */
export function assertFetchMethod(method: unknown): string {
  if (method === undefined || method === null) return 'GET';
  if (typeof method !== 'string' || method.trim().length === 0) {
    throw refusal('invalid_arguments', 'net.fetch method must be a non-empty string');
  }
  const upper = method.trim().toUpperCase();
  if (!FETCH_METHODS.has(upper)) {
    throw refusal(
      'invalid_arguments',
      `net.fetch method "${upper}" is not allowed (${[...FETCH_METHODS].join(', ')})`,
    );
  }
  return upper;
}

/**
 * Validate and copy the request headers.
 *
 * Every name and value must be a non-empty string with no CR, LF or NUL, so a
 * value cannot split the header block; the count is capped. The names in
 * {@link DENIED_HEADERS} are refused rather than dropped, because silently
 * ignoring one would make a tool believe it sent something it did not.
 */
export function assertFetchHeaders(headers: unknown): Record<string, string> {
  if (headers === undefined || headers === null) return {};
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    throw refusal('invalid_arguments', 'net.fetch headers must be an object of strings');
  }
  const entries = Object.entries(headers as Record<string, unknown>);
  if (entries.length > SANDBOX_MAX_NET_HEADERS) {
    throw refusal(
      'invalid_arguments',
      `net.fetch headers are limited to ${SANDBOX_MAX_NET_HEADERS} entries`,
    );
  }
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (name.length === 0 || name.length > MAX_HEADER_NAME_LENGTH) {
      throw refusal(
        'invalid_arguments',
        `net.fetch header names are 1-${MAX_HEADER_NAME_LENGTH} characters`,
      );
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw refusal('invalid_arguments', `net.fetch header "${name}" must be a non-empty string`);
    }
    if (value.length > MAX_HEADER_VALUE_LENGTH) {
      throw refusal(
        'invalid_arguments',
        `net.fetch header "${name}" is longer than ${MAX_HEADER_VALUE_LENGTH} characters`,
      );
    }
    if (/[\r\n]/.test(name) || name.includes('\0') || /[\r\n]/.test(value) || value.includes('\0')) {
      throw refusal(
        'invalid_arguments',
        `net.fetch header "${name}" must not contain CR, LF or NUL`,
      );
    }
    if (DENIED_HEADERS.has(name.toLowerCase())) {
      throw refusal('invalid_arguments', `net.fetch may not set the "${name}" header`);
    }
    out[name] = value;
  }
  return out;
}

/**
 * Validate a declared `env.read` list.
 *
 * Names are exact and bounded: no globs, no `'*'`, no duplicates. This runs on
 * the manifest before anything is resolved, so a hand-written `tool.json`
 * cannot ask for every secret the host holds with one wildcard. It is exported
 * because `defineTool` enforces the same shape at the authoring boundary.
 */
export function assertEnvNames(read: unknown): string[] {
  if (read === undefined || read === null) return [];
  if (!Array.isArray(read)) {
    throw refusal('invalid_arguments', 'env.read must be an array of environment variable names');
  }
  if (read.length > SANDBOX_MAX_ENV_ENTRIES) {
    throw refusal('invalid_arguments', `env.read is limited to ${SANDBOX_MAX_ENV_ENTRIES} names`);
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const [index, name] of read.entries()) {
    if (typeof name !== 'string' || !ENV_NAME_PATTERN.test(name)) {
      throw refusal(
        'invalid_arguments',
        `env.read[${index}] must be an environment variable name matching ${ENV_NAME_PATTERN.source}`,
      );
    }
    if (seen.has(name)) {
      throw refusal('invalid_arguments', `env.read names "${name}" twice`);
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

/** Rule 10: argv shape before any grant is considered. */
function assertArgvShape(argv: unknown): asserts argv is string[] {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw refusal(
      'invalid_arguments',
      'process.run requires a non-empty argv array (an executable plus arguments, never a shell string)',
    );
  }
  if (argv.length > MAX_ARGV_ENTRIES) {
    throw refusal('invalid_arguments', `process.run argv is limited to ${MAX_ARGV_ENTRIES} entries`);
  }
  for (const [index, arg] of argv.entries()) {
    if (typeof arg !== 'string' || arg.length === 0) {
      throw refusal('invalid_arguments', `process.run argv[${index}] must be a non-empty string`);
    }
    if (arg.includes('\0')) {
      throw refusal('invalid_arguments', `process.run argv[${index}] must not contain NUL bytes`);
    }
    if (arg.length > MAX_ARGV_LENGTH) {
      throw refusal(
        'invalid_arguments',
        `process.run argv[${index}] is longer than ${MAX_ARGV_LENGTH} characters`,
      );
    }
  }
}

/** Rules 1-3: shape and workspace containment, without a realpath check. */
function assertSafeRelativePath(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw refusal('invalid_arguments', `${label} path must be a non-empty string`);
  }
  if (input.length > MAX_PATH_LENGTH) {
    throw refusal(
      'invalid_arguments',
      `${label} paths are limited to ${MAX_PATH_LENGTH} characters`,
    );
  }
  if (input.includes('\0')) {
    throw refusal('invalid_arguments', `${label} paths must not contain NUL bytes`);
  }
  if (UNC_PATTERN.test(input)) {
    throw refusal('path_outside_workspace', 'UNC paths are outside the workspace');
  }
  if (input.startsWith('/')) {
    throw refusal('path_outside_workspace', 'absolute paths are outside the workspace');
  }
  if (input.startsWith('~')) {
    throw refusal('path_outside_workspace', '"~" paths are outside the workspace');
  }
  if (DRIVE_PATTERN.test(input)) {
    throw refusal('path_outside_workspace', 'drive-absolute paths are outside the workspace');
  }
  if (input.includes('\\')) {
    throw refusal('invalid_arguments', 'workspace paths use "/" separators, not "\\"');
  }
  const segments = input.split('/');
  for (const segment of segments) {
    if (segment === '') {
      throw refusal('invalid_arguments', `${label} paths must not contain empty segments`);
    }
    if (segment === '.') {
      throw refusal('invalid_arguments', `${label} paths must not contain "." segments`);
    }
    if (segment === '..') {
      throw refusal('path_outside_workspace', '".." segments are outside the workspace');
    }
    assertSafeSegment(segment, label);
  }
  return segments.join('/');
}

/**
 * M1: reject the segment shapes NTFS quietly rewrites.
 *
 * - any `:` is an alternate data stream (`.env::$DATA` reads `.env`) or a drive
 *   prefix (`C:` is already refused as absolute, this catches the rest);
 * - a trailing `.` or space is stripped by Windows, so `.git.` becomes `.git`;
 * - a reserved device name, with or without an extension (`con.txt`).
 */
function assertSafeSegment(segment: string, label: string): void {
  if (segment.includes(':')) {
    throw refusal(
      'invalid_arguments',
      `${label} paths must not contain ":" (NTFS streams are not workspace files)`,
    );
  }
  if (/[. ]$/.test(segment)) {
    throw refusal('invalid_arguments', `${label} paths must not end with "." or " "`);
  }
  const stem = (segment.split('.')[0] ?? '').toLowerCase();
  if (RESERVED_DEVICE_NAMES.has(stem) || RESERVED_DEVICE_NAMES.has(segment.toLowerCase())) {
    throw refusal('invalid_arguments', `"${segment}" is a reserved Windows device name`);
  }
}

/** Like {@link assertSafeRelativePath}, but the bare root is spelled `''` or `'.'`. */
function assertDirectoryPath(input: unknown, label: string): string {
  if (input === '' || input === '.') return '';
  return assertSafeRelativePath(input, label);
}

/** Rules 3-4: lexical containment, then realpath containment for symlinks. */
function assertInsideWorkspace(relative: string, workspace: string, label: string): string {
  const host = hostNow();
  const root = host.path.resolve(workspace);
  const resolved = host.path.resolve(root, relative);
  if (!isInside(resolved, root, host.caseInsensitive)) {
    throw refusal('path_outside_workspace', `${label} resolves outside the workspace`);
  }
  assertRealInside(resolved, workspace);
  assertDeniedReal(resolved, workspace);
  return resolved;
}

/**
 * M3: run the deny lists on the real target as well. A junction inside the
 * workspace pointing at `.git` (or a symlink to `.env`) is otherwise allowed,
 * because {@link assertNotDenied} only ever saw the literal path.
 */
function assertDeniedReal(resolved: string, workspace: string): void {
  const relative = realRelativeToWorkspace(resolved, workspace);
  if (relative === undefined) return;
  assertNotDenied(relative);
}

/** The real target's path relative to the real workspace root, or `undefined`. */
function realRelativeToWorkspace(resolved: string, workspace: string): string | undefined {
  const host = hostNow();
  const realRoot = realpathOrSelf(host.path.resolve(workspace));
  const realTarget = realpathDeepest(resolved);
  const relative = host.path.relative(realRoot, realTarget);
  if (relative === '') return undefined;
  if (relative.startsWith('..') || host.path.isAbsolute(relative)) return undefined;
  return relative.split(host.path.sep).join('/');
}

/**
 * True when `absolute` resolves (through any link) onto a denied segment or name
 * inside the workspace. Exported for the broker's list and glob paths.
 */
export function isDeniedRealPath(absolute: string, workspace: string): boolean {
  const relative = realRelativeToWorkspace(absolute, workspace);
  if (relative === undefined) return false;
  return deniedSegment(relative.split('/')) !== undefined || deniedName(relative) !== undefined;
}

function assertRealInside(resolved: string, workspace: string): void {
  const host = hostNow();
  const realRoot = realpathOrSelf(host.path.resolve(workspace));
  const realTarget = realpathDeepest(resolved);
  if (!isInside(realTarget, realRoot, host.caseInsensitive)) {
    throw refusal('path_outside_workspace', 'the path resolves outside the workspace through a link');
  }
}

/** Realpath `target`, or its deepest existing ancestor when it does not exist yet. */
function realpathDeepest(target: string): string {
  const host = hostNow();
  let current = target;
  for (let depth = 0; depth < MAX_PATH_LENGTH; depth += 1) {
    if (host.fs.existsSync(current)) return realpathOrSelf(current);
    const parent = host.path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return realpathOrSelf(current);
}

function realpathOrSelf(target: string): string {
  const host = hostNow();
  try {
    return host.fs.realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * Self-protection: a tool may not write into the runtime that is running it.
 *
 * Two checks, cheapest first: a forbidden segment anywhere in the path, then the
 * resolved target against the host's protected roots. Reads are deliberately not
 * restricted this way — inspecting the runtime cannot break it.
 */
function assertNotProtected(
  relative: string,
  resolved: string,
  workspace: string,
  options?: PathPolicyOptions,
): void {
  for (const segment of relative.split('/')) {
    const lower = segment.toLowerCase();
    if (PROTECTED_WRITE_SEGMENTS.has(lower)) {
      throw refusal(
        'protected_path',
        `"${segment}" belongs to the runtime and is not writable by a tool`,
      );
    }
  }

  const roots = options?.protectedRoots;
  if (roots === undefined || roots.length === 0) {
    return;
  }

  const host = hostNow();
  for (const root of roots) {
    if (typeof root !== 'string' || root.trim().length === 0) continue;
    if (!host.path.isAbsolute(root)) continue;

    const normalizedRoot = host.path.resolve(root);
    if (isInside(resolved, normalizedRoot, host.caseInsensitive)) {
      throw refusal(
        'protected_path',
        `"${relative}" is inside the runtime directory ${normalizedRoot}`,
      );
    }

    // The workspace itself can be a runtime checkout: a write anywhere in it
    // would still land in the code that is executing the tool.
    if (isInside(host.path.resolve(workspace), normalizedRoot, host.caseInsensitive)) {
      throw refusal(
        'protected_path',
        `the workspace is inside the runtime directory ${normalizedRoot}`,
      );
    }
  }
}

/** Rules 5-6: deny lists, checked after containment and before grants. */
function assertNotDenied(relative: string): void {
  const segments = relative.split('/');
  const segment = deniedSegment(segments);
  if (segment !== undefined) {
    throw refusal('path_denied', `"${segment}" is on the sandbox deny list`);
  }
  const name = deniedName(relative);
  if (name !== undefined) {
    throw refusal('secret_path_denied', `the path matches the denied pattern "${name}"`);
  }
}

function deniedSegment(segments: readonly string[]): string | undefined {
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (DENIED_SEGMENTS.has(lower)) return lower;
  }
  return undefined;
}

function deniedName(relative: string): string | undefined {
  const last = (relative.split('/').pop() ?? '').toLowerCase();
  // M1: if a `:` ever reaches this far, the deny list must see the stream's
  // owner name (`.env`), never `.env::$data`.
  const name = last.includes(':') ? last.slice(0, last.indexOf(':')) : last;
  for (const pattern of NAME_PATTERNS) {
    if (pattern.matcher.test(name)) return pattern.source;
  }
  return undefined;
}

/** True when `name` is a denied directory segment, case-insensitively. */
export function isDeniedSegmentName(name: string): boolean {
  return DENIED_SEGMENTS.has(name.toLowerCase());
}

/** True when `name` matches a denied file name or pattern, case-insensitively. */
export function isDeniedFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return NAME_PATTERNS.some((pattern) => pattern.matcher.test(lower));
}

/** Rule 7: a grant must match, otherwise the tool gets nothing. */
function assertGranted(
  relative: string,
  mode: 'read' | 'write',
  capabilities: ManifestCapabilities,
): void {
  const patterns = mode === 'read' ? capabilities.fs.read : capabilities.fs.write;
  if (granted(patterns, relative)) return;
  throw refusal('capability_denied', `no fs.${mode} grant matches "${relative}"`);
}

function granted(patterns: readonly string[], relative: string): boolean {
  const host = hostNow();
  // n5: on a case-insensitive filesystem a grant must match regardless of case.
  const target = host.caseInsensitive ? relative.toLowerCase() : relative;
  for (const pattern of patterns) {
    try {
      const source = host.caseInsensitive ? pattern.toLowerCase() : pattern;
      if (globToRegExp(source).test(target)) return true;
    } catch {
      // A malformed grant never grants anything.
    }
  }
  return false;
}

/** True when any read grant matches this exact path. */
export function isGrantedPath(relative: string, patterns: readonly string[]): boolean {
  return granted(patterns, relative);
}

/**
 * True when a read grant covers this directory: the grant matches the directory
 * itself, or it points at something beneath it (`docs/**` covers `docs`).
 */
export function isGrantedDirectory(relative: string, patterns: readonly string[]): boolean {
  if (relative === '') return patterns.length > 0;
  if (granted(patterns, relative)) return true;
  const host = hostNow();
  const directory = `${host.caseInsensitive ? relative.toLowerCase() : relative}/`;
  for (const pattern of patterns) {
    let normalized: string;
    try {
      normalized = normalizeGlobPattern(pattern);
    } catch {
      continue;
    }
    const candidate = host.caseInsensitive ? normalized.toLowerCase() : normalized;
    if (candidate.startsWith(directory) || candidate.startsWith('**/')) return true;
  }
  return false;
}

function namePatternToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('')
    .map((char) => (char === '*' ? '[^/]*' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`, 'i');
}

function sameName(left: string, right: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isInside(candidate: string, root: string, caseInsensitive: boolean): boolean {
  const host = hostNow();
  const normalize = (value: string): string => {
    const trimmed = value.length > 1 && value.endsWith(host.path.sep)
      ? value.slice(0, -1)
      : value;
    return caseInsensitive ? trimmed.toLowerCase() : trimmed;
  };
  const child = normalize(candidate);
  const parent = normalize(root);
  return child === parent || child.startsWith(`${parent}${host.path.sep}`);
}

function deniedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (DENIED_ENV_KEYS.has(upper)) return true;
  return DENIED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

function refusal(
  code:
    | 'invalid_arguments'
    | 'path_outside_workspace'
    | 'path_denied'
    | 'protected_path'
    | 'secret_path_denied'
    | 'capability_denied'
    | 'process_argv_denied'
    | 'net_disabled'
    | 'net_denied'
    | 'net_failed',
  message: string,
): ToolRuntimeError {
  return new ToolRuntimeError(code, message);
}
