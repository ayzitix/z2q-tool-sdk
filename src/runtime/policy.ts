import { globToRegExp, normalizeGlobPattern } from '../context.js';
import type { ManifestCapabilities } from '../types.js';
import { ToolRuntimeError } from './errors.js';
import { hostNow, runtimeHost } from './host.js';

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
): string {
  const host = hostNow();
  const relative = assertSafeRelativePath(input, 'fs.write');
  const resolved = assertInsideWorkspace(relative, workspace, 'fs.write');
  assertNotDenied(relative);
  assertGranted(relative, 'write', capabilities);

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
    | 'secret_path_denied'
    | 'capability_denied'
    | 'process_argv_denied',
  message: string,
): ToolRuntimeError {
  return new ToolRuntimeError(code, message);
}
