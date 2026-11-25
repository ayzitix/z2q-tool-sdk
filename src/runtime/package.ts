import { isToolManifest } from '../manifest.js';
import type { ToolManifest } from '../types.js';
import { ToolRuntimeError } from './errors.js';
import { runtimeHost } from './host.js';
import { SANDBOX_MAX_BUNDLE_BYTES } from './limits.js';

/** A built tool, ready for the sandbox. */
export interface ToolPackage {
  readonly manifest: ToolManifest;
  /** The ESM bundle text, exactly as `dist/index.js` holds it. */
  readonly source: string;
  /** Hex SHA-256 of {@link ToolPackage.source}. */
  readonly sha256: string;
  /** Absolute tool directory, when the package came from disk. */
  readonly dir?: string;
}

/**
 * Read `dist/tool.json` and `dist/index.js` from a built tool directory.
 *
 * The manifest is validated with the same structural check `buildTool` and
 * `packTool` use; the bundle is capped at {@link SANDBOX_MAX_BUNDLE_BYTES}.
 * Nothing is executed here.
 */
export async function loadToolPackage(dir: string): Promise<ToolPackage> {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new ToolRuntimeError('invalid_tool', 'loadToolPackage requires a tool directory');
  }
  const host = await runtimeHost();
  const root = host.path.resolve(dir);
  const manifestPath = host.path.join(root, 'dist', 'tool.json');
  const sourcePath = host.path.join(root, 'dist', 'index.js');

  let manifestText: string;
  try {
    manifestText = host.fs.readFileSync(manifestPath);
  } catch {
    throw new ToolRuntimeError('invalid_tool', `missing dist/tool.json in ${root} (run: z1-tool build)`);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new ToolRuntimeError('invalid_tool', `dist/tool.json in ${root} is not valid JSON`);
  }
  if (!isToolManifest(manifest)) {
    throw new ToolRuntimeError('invalid_tool', `dist/tool.json in ${root} is not a tool manifest`);
  }

  let size: number;
  try {
    size = host.fs.statSync(sourcePath).size;
  } catch {
    throw new ToolRuntimeError('invalid_tool', `missing dist/index.js in ${root} (run: z1-tool build)`);
  }
  if (size > SANDBOX_MAX_BUNDLE_BYTES) {
    throw new ToolRuntimeError(
      'invalid_tool',
      `dist/index.js in ${root} is ${size} bytes, over the ${SANDBOX_MAX_BUNDLE_BYTES} byte bundle limit`,
    );
  }
  let source: string;
  try {
    source = host.fs.readFileSync(sourcePath);
  } catch {
    throw new ToolRuntimeError('invalid_tool', `cannot read dist/index.js in ${root}`);
  }
  if (Buffer.byteLength(source, 'utf8') > SANDBOX_MAX_BUNDLE_BYTES) {
    throw new ToolRuntimeError(
      'invalid_tool',
      `dist/index.js in ${root} is over the ${SANDBOX_MAX_BUNDLE_BYTES} byte bundle limit`,
    );
  }

  return {
    manifest,
    source,
    sha256: host.crypto.sha256Hex(source),
    dir: root,
  };
}
