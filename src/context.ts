import type { GrepOptions, ProcessRunOptions } from './types.js';

interface ParsedPath {
  root: string;
  segments: string[];
}

const DRIVE_PATTERN = /^([A-Za-z]):(?:\/|$)/;

function parsePath(input: string): ParsedPath {
  const value = input.replace(/\\/g, '/');
  let root = '';
  let rest = value;

  const drive = DRIVE_PATTERN.exec(value);
  if (drive) {
    root = `${(drive[1] ?? '').toLowerCase()}:`;
    rest = value.slice(2);
  } else if (value.startsWith('//')) {
    const parts = value.slice(2).split('/');
    const server = parts[0] ?? '';
    const share = parts[1] ?? '';
    if (server.length > 0 && share.length > 0) {
      root = `//${server.toLowerCase()}/${share.toLowerCase()}`;
      rest = parts.slice(2).join('/');
    }
  } else if (value.startsWith('/')) {
    root = '/';
  }

  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return { root, segments };
}

function formatPath(root: string, segments: string[]): string {
  const body = segments.join('/');
  return root === '/' ? `/${body}` : `${root}/${body}`;
}

function isCaseInsensitive(root: string): boolean {
  return root !== '/';
}

function rawSegments(input: string): string[] {
  return input
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
}

/**
 * Lexically resolve a tool path against the workspace and reject anything that
 * leaves it. This is a best-effort SDK check: symlinks, mounts and TOCTOU are
 * the runtime broker's problem, and only the broker actually enforces access.
 */
export function resolveToolPath(workspace: string, path: string): string {
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw new TypeError('workspace must be a non-empty absolute path');
  }
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('path must be a non-empty string');
  }
  if (path.includes('\0')) {
    throw new TypeError('path must not contain NUL bytes');
  }

  const base = parsePath(workspace);
  if (base.root === '') {
    throw new TypeError(`workspace must be absolute: ${workspace}`);
  }
  const candidate = parsePath(path);
  const caseInsensitive = isCaseInsensitive(base.root);
  const same = (a: string, b: string): boolean =>
    caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;

  let segments: string[];
  if (candidate.root !== '') {
    if (!same(candidate.root, base.root)) {
      throw new RangeError(`path is outside the workspace: ${path}`);
    }
    segments = candidate.segments;
  } else {
    segments = [...base.segments];
    for (const segment of rawSegments(path)) {
      if (segment === '..') {
        if (segments.length <= base.segments.length) {
          throw new RangeError(`path escapes the workspace: ${path}`);
        }
        segments.pop();
      } else {
        segments.push(segment);
      }
    }
  }

  if (segments.length < base.segments.length) {
    throw new RangeError(`path is outside the workspace: ${path}`);
  }
  for (let index = 0; index < base.segments.length; index += 1) {
    if (!same(base.segments[index] ?? '', segments[index] ?? '')) {
      throw new RangeError(`path is outside the workspace: ${path}`);
    }
  }

  return formatPath(base.root, segments);
}

/** Turn a resolved absolute path back into a workspace-relative, `/`-separated path. */
export function workspaceRelativePath(workspace: string, target: string): string {
  const base = parsePath(workspace);
  const resolved = parsePath(target);
  const segments = resolved.segments.slice(base.segments.length);
  return segments.length > 0 ? segments.join('/') : '.';
}

/** Validate and normalize a workspace-relative glob pattern. */
export function normalizeGlobPattern(pattern: string): string {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new TypeError('glob pattern must be a non-empty string');
  }
  if (pattern.includes('\0')) {
    throw new TypeError('glob pattern must not contain NUL bytes');
  }
  let value = pattern.replace(/\\/g, '/');
  value = value.replace(/^\.\//, '');
  if (value.startsWith('/') || DRIVE_PATTERN.test(value) || value.startsWith('//')) {
    throw new RangeError(`glob pattern must be workspace-relative: ${pattern}`);
  }
  const segments = value.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    throw new RangeError(`glob pattern escapes the workspace: ${pattern}`);
  }
  if (segments.length === 0) {
    throw new RangeError(`glob pattern is empty: ${pattern}`);
  }
  return segments.join('/');
}

/** Translate a workspace-relative glob (`*`, `**`, `?`) into a RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeGlobPattern(pattern);
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*') {
      const next = normalized[index + 1];
      if (next === '*') {
        const after = normalized[index + 2];
        const atSegmentStart = index === 0 || normalized[index - 1] === '/';
        if (atSegmentStart && after === '/') {
          source += '(?:[^/]+/)*';
          index += 2;
          continue;
        }
        if (atSegmentStart && after === undefined) {
          source += '.*';
          index += 1;
          continue;
        }
      }
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(char ?? '');
    }
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Enforce the argv-only contract at the SDK boundary. */
export function assertArgv(argv: unknown): asserts argv is string[] {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new TypeError(
      'process.run requires a non-empty argv array (an executable plus arguments, never a shell string)',
    );
  }
  for (const [index, arg] of argv.entries()) {
    if (typeof arg !== 'string' || arg.length === 0) {
      throw new TypeError(`process.run argv[${index}] must be a non-empty string`);
    }
    if (arg.includes('\0')) {
      throw new TypeError(`process.run argv[${index}] must not contain NUL bytes`);
    }
  }
}

/** Validate an http(s) URL at the SDK boundary. */
export function assertFetchUrl(url: unknown): asserts url is string {
  if (typeof url !== 'string' || !/^https?:\/\/\S+$/i.test(url)) {
    throw new TypeError(`net.fetch requires an absolute http(s) URL, got ${String(url)}`);
  }
}

/** Normalize optional grep options and reject nonsense early. */
export function normalizeGrepOptions(options: GrepOptions | undefined): GrepOptions {
  if (options === undefined) return {};
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('fs.grep options must be an object');
  }
  if (options.glob !== undefined) normalizeGlobPattern(options.glob);
  if (options.ignoreCase !== undefined && typeof options.ignoreCase !== 'boolean') {
    throw new TypeError('fs.grep options.ignoreCase must be a boolean');
  }
  return options;
}

/** Exported for adapters that want the same argument checks as the test harness. */
export function assertProcessOptions(options: unknown): asserts options is ProcessRunOptions {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('process.run requires an options object with argv');
  }
  assertArgv((options as { argv?: unknown }).argv);
}
