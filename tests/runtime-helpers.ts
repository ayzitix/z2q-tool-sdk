import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { buildTool } from '../src/index.js';
import type { ManifestCapabilities, ToolManifest } from '../src/index.js';
import { ToolRuntimeError } from '../src/runtime/errors.js';
import type { ToolRuntimeCode } from '../src/runtime/errors.js';

/**
 * Shared plumbing for the runtime specs: temp dirs that are always removed,
 * tool packages built with the real `buildTool`, and raw packages written by
 * hand for the cases where a full zod bundle would only slow the test down.
 */

export const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const tempDirs: string[] = [];

export async function tempDir(prefix = 'z1-runtime-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
}

/** A `/`-separated relative import specifier, for temp tools that import this checkout. */
export function relativeSpecifier(fromDir: string, targetFile: string): string {
  const rel = relative(fromDir, targetFile).split('\\').join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

export interface BuiltFixture {
  dir: string;
  manifest: ToolManifest;
  source: string;
  sha256: string;
}

/**
 * Build a fixture whose source uses `__SDK__` and `__ZOD__` where the SDK and
 * zod imports go, then read the bundle back.
 */
export async function buildToolFixture(
  toolSource: string,
  prefix = 'z1-fixture-',
): Promise<BuiltFixture> {
  const dir = await tempDir(prefix);
  const sdk = relativeSpecifier(dir, join(repoRoot, 'src', 'index.ts'));
  const zod = relativeSpecifier(dir, join(repoRoot, 'node_modules', 'zod', 'index.js'));
  await writeFile(
    join(dir, 'tool.ts'),
    toolSource.replace('__SDK__', sdk).replace('__ZOD__', zod),
    'utf8',
  );
  const built = await buildTool({ entry: join(dir, 'tool.ts'), outDir: join(dir, 'dist') });
  const source = await readFile(built.bundlePath, 'utf8');
  const sha256 = createHash('sha256').update(source, 'utf8').digest('hex');
  return { dir, manifest: built.manifest, source, sha256 };
}

/** Default capabilities, as `defineTool` would write them. */
export function capabilities(overrides: {
  read?: string[];
  write?: string[];
  argv?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
} = {}): ManifestCapabilities {
  return {
    fs: { read: overrides.read ?? [], write: overrides.write ?? [] },
    process: { argv: overrides.argv ?? [] },
    net: { hosts: [] },
    limits: {
      timeoutMs: overrides.timeoutMs ?? 30_000,
      maxOutputBytes: overrides.maxOutputBytes ?? 1_048_576,
    },
  };
}

export function rawManifest(overrides: {
  name?: string;
  description?: string;
  limits?: { timeoutMs?: number; maxOutputBytes?: number };
  read?: string[];
  write?: string[];
  argv?: string[];
} = {}): ToolManifest {
  return {
    schemaVersion: 1,
    name: overrides.name ?? 'tool.raw',
    version: '0.1.0',
    description: overrides.description ?? 'A raw fixture package.',
    parameters: { type: 'object', properties: {} },
    capabilities: capabilities({
      ...(overrides.read === undefined ? {} : { read: overrides.read }),
      ...(overrides.write === undefined ? {} : { write: overrides.write }),
      ...(overrides.argv === undefined ? {} : { argv: overrides.argv }),
      ...(overrides.limits?.timeoutMs === undefined ? {} : { timeoutMs: overrides.limits.timeoutMs }),
      ...(overrides.limits?.maxOutputBytes === undefined
        ? {}
        : { maxOutputBytes: overrides.limits.maxOutputBytes }),
    }),
  };
}

/**
 * Write a raw package (`dist/tool.json` + `dist/index.js`) by hand.
 *
 * The limit specs use these instead of a zod bundle: they exercise the same
 * runtime paths without paying for a full build. The teardown abort that
 * quickjs-emscripten 0.32.0 throws for multi-megabyte strings is documented in
 * SECURITY.md and is not what those specs measure.
 */
export async function writeRawPackage(
  dir: string,
  source: string,
  manifest: ToolManifest,
): Promise<void> {
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(join(dir, 'dist', 'tool.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(join(dir, 'dist', 'index.js'), source, 'utf8');
}

/** A raw tool source with the given `run` body and a pass-through schema. */
export function rawToolSource(manifest: ToolManifest, runBody: string): string {
  return `export const tool = {
  manifest: ${JSON.stringify(manifest)},
  parameters: {
    safeParse: (value) => {
      if (value !== null && typeof value === 'object' && value.__reject === true) {
        return { success: false, error: { issues: [{ path: ['mode'], message: 'rejected by the fixture' }] } };
      }
      return { success: true, data: value === undefined ? {} : value };
    },
  },
  run: async (ctx, args) => ${runBody},
};
`;
}

/** Assert a promise rejects with a `ToolRuntimeError` of the given code. */
export async function expectRuntimeError(
  run: () => Promise<unknown>,
  code: ToolRuntimeCode,
): Promise<ToolRuntimeError> {
  try {
    await run();
  } catch (error) {
    expect(error, `expected a ToolRuntimeError with code ${code}`).toBeInstanceOf(ToolRuntimeError);
    const runtimeError = error as ToolRuntimeError;
    expect(runtimeError.code).toBe(code);
    return runtimeError;
  }
  throw new Error(`expected a ToolRuntimeError with code ${code}, but the call resolved`);
}
