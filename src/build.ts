import { isToolManifest } from './manifest.js';
import { toPlainJson } from './schema.js';
import type { AnyToolDefinition, ToolManifest } from './types.js';

export interface BuildToolOptions {
  /** Path to the tool entry (usually `tool.ts`). Relative paths resolve against `cwd`. */
  entry: string;
  /** Output directory. Defaults to `<entry dir>/dist`. */
  outDir?: string;
  /** Base for relative paths. Defaults to `process.cwd()`. */
  cwd?: string;
  minify?: boolean;
  sourcemap?: boolean;
  /** Extra esbuild externals. Node builtins are always external. */
  external?: string[];
}

export interface BuildToolResult {
  entry: string;
  bundlePath: string;
  manifestPath: string;
  manifest: ToolManifest;
}

export interface PackToolOptions {
  /** Tool directory containing `dist/tool.json`, `dist/index.js` and `package.json`. */
  dir: string;
  cwd?: string;
  /** Defaults to `<dir>/<name>-<version>.tgz`. */
  outFile?: string;
}

export interface PackToolResult {
  path: string;
  sha256: string;
  bytes: number;
  entries: string[];
}

interface TarEntry {
  name: string;
  data: Buffer;
}

interface PackageJson {
  name?: string;
  version?: string;
  author?: string | { name?: string };
}

/**
 * Bundle a tool entry and write `tool.json` next to the bundle.
 *
 * This imports the bundled module to read its definition, but never calls
 * `run`. It needs `esbuild`, resolved from the tool project first and from the
 * SDK installation second.
 */
export async function buildTool(options: BuildToolOptions): Promise<BuildToolResult> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  if (typeof options !== 'object' || options === null || typeof options.entry !== 'string') {
    throw new TypeError('buildTool requires { entry: string }');
  }
  const cwd = options.cwd ?? process.cwd();
  const entry = path.resolve(cwd, options.entry);
  const entryStat = await fs.stat(entry).catch(() => undefined);
  if (entryStat === undefined || !entryStat.isFile()) {
    throw new Error(`build entry not found: ${entry}`);
  }

  const outDir = path.resolve(cwd, options.outDir ?? path.join(path.dirname(entry), 'dist'));
  await fs.mkdir(outDir, { recursive: true });
  const bundlePath = path.join(outDir, 'index.js');

  const esbuild = await loadEsbuild(path.dirname(entry));
  try {
    await esbuild.build({
      entryPoints: [entry],
      outfile: bundlePath,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      sourcemap: options.sourcemap ?? false,
      minify: options.minify ?? false,
      external: options.external ?? [],
      logLevel: 'silent',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to bundle ${entry}: ${detail}`);
  }

  const tool = await importToolDefinition(bundlePath);
  const manifestPath = path.join(outDir, 'tool.json');
  await fs.writeFile(manifestPath, `${JSON.stringify(tool.manifest, null, 2)}\n`, 'utf8');

  return {
    entry,
    bundlePath,
    manifestPath,
    manifest: tool.manifest,
  };
}

/**
 * Pack a built tool into a gzipped tar with exactly four entries: `tool.json`,
 * `dist/index.js`, `package.json` and `LICENSE`. Returns the file hash.
 */
export async function packTool(options: PackToolOptions): Promise<PackToolResult> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const zlib = await import('node:zlib');
  const { createHash } = await import('node:crypto');

  if (typeof options !== 'object' || options === null || typeof options.dir !== 'string') {
    throw new TypeError('packTool requires { dir: string }');
  }
  const cwd = options.cwd ?? process.cwd();
  const dir = path.resolve(cwd, options.dir);
  const manifestText = await fs.readFile(path.join(dir, 'dist', 'tool.json'), 'utf8');
  const manifest = JSON.parse(manifestText) as ToolManifest;
  if (!isToolManifest(manifest)) {
    throw new Error(`invalid dist/tool.json in ${dir}`);
  }
  const packageText = await fs.readFile(path.join(dir, 'package.json'), 'utf8');
  const pkg = JSON.parse(packageText) as PackageJson;
  const bundle = await fs.readFile(path.join(dir, 'dist', 'index.js'));

  let license: string;
  try {
    license = await fs.readFile(path.join(dir, 'LICENSE'), 'utf8');
  } catch {
    license = mitLicenseText(authorOf(pkg) ?? `${manifest.name} authors`);
  }

  const entries: TarEntry[] = [
    { name: 'tool.json', data: Buffer.from(manifestText, 'utf8') },
    { name: 'dist/index.js', data: bundle },
    { name: 'package.json', data: Buffer.from(packageText, 'utf8') },
    { name: 'LICENSE', data: Buffer.from(license, 'utf8') },
  ];

  const archive = zlib.gzipSync(createTar(entries));
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const outFile =
    options.outFile === undefined
      ? path.join(dir, `${manifest.name.replace(/[^a-zA-Z0-9._-]+/g, '-')}-${manifest.version}.tgz`)
      : path.resolve(cwd, options.outFile);
  await fs.writeFile(outFile, archive);

  return {
    path: outFile,
    sha256,
    bytes: archive.length,
    entries: entries.map((entry) => entry.name),
  };
}

/** A standard MIT text, used for generated projects and LICENSE-less packs. */
export function mitLicenseText(holder: string, year = new Date().getFullYear()): string {
  return `MIT License

Copyright (c) ${year} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

async function loadEsbuild(fromDir: string): Promise<typeof import('esbuild')> {
  const path = await import('node:path');
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');

  const bases = [
    path.join(fromDir, 'package.json'),
    path.join(process.cwd(), 'package.json'),
  ];
  for (const base of bases) {
    try {
      const resolveFrom = createRequire(base);
      const resolved = resolveFrom.resolve('esbuild');
      return await importEsbuild(pathToFileURL(resolved).href);
    } catch {
      // Try the next location.
    }
  }
  try {
    const resolved = createRequire(import.meta.url).resolve('esbuild');
    return await importEsbuild(pathToFileURL(resolved).href);
  } catch {
    throw new Error(
      'buildTool requires esbuild. Install it in your tool project: npm install --save-dev esbuild',
    );
  }
}

async function importEsbuild(url: string): Promise<typeof import('esbuild')> {
  const module = (await import(url)) as unknown as {
    build?: unknown;
    default?: typeof import('esbuild');
  };
  if (typeof module.build === 'function') {
    return module as unknown as typeof import('esbuild');
  }
  if (module.default !== undefined) {
    return module.default;
  }
  throw new Error('the installed esbuild package does not export build()');
}

async function importToolDefinition(bundlePath: string): Promise<AnyToolDefinition> {
  const { pathToFileURL } = await import('node:url');
  const url = `${pathToFileURL(bundlePath).href}?z1-tool-sdk=${Date.now()}`;
  const module = (await import(url)) as Record<string, unknown>;
  const candidate = module.tool ?? module.default ?? module;
  return assertToolDefinition(candidate, bundlePath);
}

function assertToolDefinition(value: unknown, file: string): AnyToolDefinition {
  const hint = `${file} must export a tool created with defineTool (named export "tool" or default export)`;
  if (typeof value !== 'object' || value === null) {
    throw new Error(hint);
  }
  const candidate = value as { manifest?: unknown; run?: unknown };
  if (typeof candidate.run !== 'function') {
    throw new Error(`${hint}: run is not a function`);
  }
  if (!isToolManifest(candidate.manifest)) {
    throw new Error(`${hint}: manifest is missing or malformed`);
  }
  try {
    toPlainJson(candidate.manifest, 'manifest');
  } catch (error) {
    throw new Error(`${hint}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return candidate as AnyToolDefinition;
}

function authorOf(pkg: PackageJson): string | undefined {
  if (typeof pkg.author === 'string' && pkg.author.trim().length > 0) return pkg.author.trim();
  if (typeof pkg.author === 'object' && pkg.author !== null) {
    const name = pkg.author.name;
    if (typeof name === 'string' && name.trim().length > 0) return name.trim();
  }
  return undefined;
}

function createTar(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry.name, entry.data.length));
    chunks.push(entry.data);
    const padding = (512 - (entry.data.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function tarHeader(name: string, size: number): Buffer {
  if (Buffer.byteLength(name, 'utf8') > 100) {
    throw new Error(`tar entry name is too long: ${name}`);
  }
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.write('        ', 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}
