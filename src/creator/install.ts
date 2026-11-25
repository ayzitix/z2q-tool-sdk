import { isToolManifest } from '../manifest.js';
import type { ToolPackage } from '../runtime/package.js';
import type { ManifestCapabilities, ToolManifest } from '../types.js';
import { ToolCreatorError, isValidToolName } from './prompt.js';
import {
  assessToolManifest,
  buildToolProject,
  formatSourceIssues,
  reviewToolSource,
} from './review.js';

export interface InstallToolOptions {
  toolsDir: string;
  dir: string;
  approvedBy?: string;
  now?: () => number;
  /** Refuse unless dist/index.js has exactly this sha256. */
  expectSha256?: string;
  /** Refuse unless the manifest grants exactly these capabilities. */
  expectCapabilities?: ManifestCapabilities;
  /**
   * Allow a directory with no `tool.ts` to install its prebuilt `dist/`.
   * A directory with `tool.ts` always rebuilds, so this never skips a review.
   */
  allowPrebuilt?: boolean;
}

export interface InstalledTool {
  name: string;
  version: string;
  path: string;
  sha256: string;
  capabilities: ManifestCapabilities;
  installedAt: string;
  approvedBy?: string;
}

/** The plain-JSON record written next to every installed version. */
export interface ApprovalRecord {
  schemaVersion: 1;
  name: string;
  version: string;
  sha256: string;
  capabilities: ManifestCapabilities;
  installedAt: string;
  approvedBy?: string;
}

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Copy `dist/*` into `<toolsDir>/<name>/<version>/` and write `approval.json`.
 *
 * A directory with `tool.ts` always rebuilds before installing, so a stale
 * `dist/` can never be signed. A dist-only directory needs an explicit
 * `expectSha256` or `allowPrebuilt: true`. Versions are immutable: the version
 * directory is reserved with a non-recursive `mkdir`, so an existing version is
 * refused even if it is empty. The bundle hash is recomputed from bytes, and
 * `expectSha256` / `expectCapabilities` let the caller bind the install to the
 * artefact they reviewed.
 */
export async function installTool(options: InstallToolOptions): Promise<InstalledTool> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  if (typeof options !== 'object' || options === null) {
    throw invalidArguments('installTool requires an options object');
  }
  const toolsDir = path.resolve(requireString(options.toolsDir, 'toolsDir'));
  const dir = path.resolve(requireString(options.dir, 'dir'));
  const approvedBy = normalizeApprovedBy(options.approvedBy);
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw invalidArguments('now must be a function returning milliseconds');
  }
  const now = options.now ?? Date.now;
  const at = now();
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    throw invalidArguments('now must return a finite number of milliseconds');
  }
  const expectedSha = validateExpectedSha(options.expectSha256);
  if (options.expectCapabilities !== undefined && !isManifestCapabilities(options.expectCapabilities)) {
    throw invalidArguments('expectCapabilities must be a resolved manifest capabilities object');
  }
  if (options.allowPrebuilt !== undefined && typeof options.allowPrebuilt !== 'boolean') {
    throw invalidArguments('allowPrebuilt must be a boolean when present');
  }

  await ensureBuilt(dir, {
    allowPrebuilt: options.allowPrebuilt === true,
    expectedSha,
  });
  const pkg = await loadPackage(dir);
  const manifest = pkg.manifest;
  if (!isValidToolName(manifest.name)) {
    throw new ToolCreatorError('invalid_name', `tool name "${manifest.name}" is not a safe directory name`);
  }
  if (!VERSION_PATTERN.test(manifest.version)) {
    throw new ToolCreatorError(
      'invalid_version',
      `tool version "${manifest.version}" is not strict semver`,
    );
  }
  const assessment = assessToolManifest(manifest);
  if (!assessment.ok) {
    throw new ToolCreatorError(
      'invalid_source',
      `manifest failed review: ${formatSourceIssues(assessment.issues)}`,
      { report: assessment },
    );
  }

  const sha256 = await sha256File(path.join(dir, 'dist', 'index.js'));
  if (expectedSha !== undefined && expectedSha !== sha256) {
    throw new ToolCreatorError(
      'sha_mismatch',
      `dist/index.js hashes to ${sha256}; the approved build was ${expectedSha}`,
    );
  }
  if (
    options.expectCapabilities !== undefined &&
    capabilitiesKey(manifest.capabilities) !== capabilitiesKey(options.expectCapabilities)
  ) {
    throw new ToolCreatorError(
      'capabilities_mismatch',
      'the manifest capabilities differ from the ones that were approved',
    );
  }

  const toolDir = path.join(toolsDir, manifest.name);
  const versionDir = path.join(toolDir, manifest.version);
  await fs.mkdir(toolsDir, { recursive: true });
  const toolInfo = await fs.stat(toolDir).catch(() => undefined);
  if (toolInfo !== undefined && !toolInfo.isDirectory()) {
    throw new ToolCreatorError('version_exists', `${toolDir} exists and is not a directory`);
  }
  await fs.mkdir(toolDir, { recursive: true });

  try {
    await fs.mkdir(versionDir);
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new ToolCreatorError(
        'version_exists',
        `${manifest.name}@${manifest.version} is already installed at ${versionDir}; versions are immutable`,
      );
    }
    throw error;
  }

  try {
    await fs.mkdir(path.join(versionDir, 'dist'), { recursive: true });
    await fs.copyFile(
      path.join(dir, 'dist', 'tool.json'),
      path.join(versionDir, 'dist', 'tool.json'),
    );
    await fs.copyFile(
      path.join(dir, 'dist', 'index.js'),
      path.join(versionDir, 'dist', 'index.js'),
    );
    // The approval must cover the bytes that were written, not the bytes that
    // were hashed a moment earlier. Re-read the copy before writing the record.
    const copiedSha = await sha256File(path.join(versionDir, 'dist', 'index.js'));
    if (copiedSha !== sha256) {
      throw new ToolCreatorError(
        'sha_mismatch',
        'dist/index.js changed between the hash and the copy; refusing a partial approval',
      );
    }
    const copiedManifest = await readInstalledManifest(versionDir);
    if (
      copiedManifest === undefined ||
      copiedManifest.name !== manifest.name ||
      copiedManifest.version !== manifest.version ||
      capabilitiesKey(copiedManifest.capabilities) !== capabilitiesKey(manifest.capabilities)
    ) {
      throw new ToolCreatorError(
        'invalid_approval',
        'dist/tool.json changed between the read and the copy; refusing a partial approval',
      );
    }
    const installedAt = new Date(at).toISOString();
    const approval: ApprovalRecord = {
      schemaVersion: 1,
      name: manifest.name,
      version: manifest.version,
      sha256,
      capabilities: manifest.capabilities,
      installedAt,
      ...(approvedBy === undefined ? {} : { approvedBy }),
    };
    await fs.writeFile(
      path.join(versionDir, 'approval.json'),
      `${JSON.stringify(approval, null, 2)}\n`,
      'utf8',
    );
    return {
      name: manifest.name,
      version: manifest.version,
      path: versionDir,
      sha256,
      capabilities: manifest.capabilities,
      installedAt,
      ...(approvedBy === undefined ? {} : { approvedBy }),
    };
  } catch (error) {
    await fs.rm(versionDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Read every valid approval record under `toolsDir`, sorted by name and version. */
export async function listInstalledTools(toolsDir: string): Promise<InstalledTool[]> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const root = path.resolve(requireString(toolsDir, 'toolsDir'));
  const tools = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (isNotFound(error)) return [];
    throw error;
  });

  const installed: InstalledTool[] = [];
  for (const tool of tools) {
    if (!tool.isDirectory() || !isValidToolName(tool.name)) continue;
    const toolDir = path.join(root, tool.name);
    const versions = await fs.readdir(toolDir).catch(() => [] as string[]);
    for (const version of versions) {
      if (!VERSION_PATTERN.test(version)) continue;
      const versionDir = path.join(toolDir, version);
      const record = await readApproval(versionDir);
      if (record === undefined) continue;
      if (record.name !== tool.name || record.version !== version) continue;
      if (!(await hasDistFiles(versionDir))) continue;
      installed.push({
        name: record.name,
        version: record.version,
        path: versionDir,
        sha256: record.sha256,
        capabilities: record.capabilities,
        installedAt: record.installedAt,
        ...(record.approvedBy === undefined ? {} : { approvedBy: record.approvedBy }),
      });
    }
  }
  return installed.sort((left, right) => {
    if (left.name !== right.name) return left.name < right.name ? -1 : 1;
    return compareVersions(left.version, right.version);
  });
}

/**
 * Load an installed tool and verify the bytes against `approval.json`.
 *
 * With no version, the highest installed version is used. A changed bundle, a
 * changed `tool.json`, or capabilities different from the approval all refuse:
 * the approval covers one exact artefact.
 */
export async function loadInstalledTool(
  toolsDir: string,
  name: string,
  version?: string,
): Promise<ToolPackage> {
  const path = await import('node:path');
  if (!isValidToolName(name)) {
    throw new ToolCreatorError('invalid_name', `invalid tool name "${String(name)}"`);
  }
  const root = path.resolve(requireString(toolsDir, 'toolsDir'));
  let selected = version;
  if (selected !== undefined) {
    if (!VERSION_PATTERN.test(selected)) {
      throw new ToolCreatorError('invalid_version', `invalid version "${selected}"`);
    }
  } else {
    const matches = (await listInstalledTools(root)).filter((tool) => tool.name === name);
    if (matches.length === 0) {
      throw new ToolCreatorError('not_installed', `${name} is not installed in ${root}`);
    }
    selected = matches[matches.length - 1]?.version;
    if (selected === undefined) {
      throw new ToolCreatorError('not_installed', `${name} is not installed in ${root}`);
    }
  }

  const versionDir = path.join(root, name, selected);
  const record = await readApproval(versionDir);
  if (record === undefined || record.name !== name || record.version !== selected) {
    throw new ToolCreatorError(
      'invalid_approval',
      `approval.json is missing or does not describe ${name}@${selected}`,
    );
  }
  const pkg = await loadPackage(versionDir);
  if (pkg.sha256 !== record.sha256) {
    throw new ToolCreatorError(
      'sha_mismatch',
      `dist/index.js in ${versionDir} was modified after install`,
    );
  }
  if (pkg.manifest.name !== name || pkg.manifest.version !== selected) {
    throw new ToolCreatorError(
      'invalid_approval',
      `dist/tool.json no longer describes ${name}@${selected}`,
    );
  }
  if (capabilitiesKey(pkg.manifest.capabilities) !== capabilitiesKey(record.capabilities)) {
    throw new ToolCreatorError(
      'capabilities_mismatch',
      `dist/tool.json grants differ from the approval recorded for ${name}@${selected}`,
    );
  }
  return pkg;
}

interface EnsureBuiltOptions {
  allowPrebuilt: boolean;
  expectedSha: string | undefined;
}

async function ensureBuilt(dir: string, options: EnsureBuiltOptions): Promise<void> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const entry = path.join(dir, 'tool.ts');
  const entryInfo = await fs.stat(entry).catch(() => undefined);

  if (entryInfo?.isFile() !== true) {
    if (!(await hasDistFiles(dir))) {
      throw new ToolCreatorError(
        'missing_dist',
        `missing dist/tool.json or dist/index.js in ${dir}, and no tool.ts to build`,
      );
    }
    if (options.expectedSha === undefined && !options.allowPrebuilt) {
      throw new ToolCreatorError(
        'invalid_arguments',
        `${dir} has no tool.ts; a prebuilt dist/ needs expectSha256 or allowPrebuilt: true`,
      );
    }
    return;
  }

  const source = await fs.readFile(entry, 'utf8');
  const report = reviewToolSource(source);
  if (!report.ok) {
    throw new ToolCreatorError(
      'invalid_source',
      `source failed review: ${formatSourceIssues(report.issues)}`,
      { report },
    );
  }

  // Always rebuild when the source exists. Installing a stale dist/ would sign
  // bytes that no review covered, and the review above covers only tool.ts.
  try {
    await buildToolProject(dir);
  } catch (error) {
    throw new ToolCreatorError('build_failed', messageOf(error), { cause: error });
  }
  if (!(await hasDistFiles(dir))) {
    throw new ToolCreatorError('missing_dist', `the build did not produce dist/* in ${dir}`);
  }
}

async function hasDistFiles(dir: string): Promise<boolean> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  for (const file of ['tool.json', 'index.js']) {
    const info = await fs.stat(path.join(dir, 'dist', file)).catch(() => undefined);
    if (info?.isFile() !== true) return false;
  }
  return true;
}

async function readInstalledManifest(versionDir: string): Promise<ToolManifest | undefined> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const text = await fs.readFile(path.join(versionDir, 'dist', 'tool.json'), 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isToolManifest(parsed) ? parsed : undefined;
}

async function readApproval(versionDir: string): Promise<ApprovalRecord | undefined> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const text = await fs.readFile(path.join(versionDir, 'approval.json'), 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isApprovalRecord(parsed)) return undefined;
  return parsed;
}

function isApprovalRecord(value: unknown): value is ApprovalRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<ApprovalRecord>;
  return (
    record.schemaVersion === 1 &&
    typeof record.name === 'string' &&
    isValidToolName(record.name) &&
    typeof record.version === 'string' &&
    VERSION_PATTERN.test(record.version) &&
    typeof record.sha256 === 'string' &&
    /^[a-fA-F0-9]{64}$/.test(record.sha256) &&
    isManifestCapabilities(record.capabilities) &&
    typeof record.installedAt === 'string' &&
    record.installedAt.length > 0 &&
    (record.approvedBy === undefined || typeof record.approvedBy === 'string')
  );
}

function isManifestCapabilities(value: unknown): value is ManifestCapabilities {
  if (typeof value !== 'object' || value === null) return false;
  const capabilities = value as {
    fs?: { read?: unknown; write?: unknown };
    process?: { argv?: unknown };
    net?: { hosts?: unknown };
    limits?: { timeoutMs?: unknown; maxOutputBytes?: unknown };
  };
  return (
    isStringArray(capabilities.fs?.read) &&
    isStringArray(capabilities.fs?.write) &&
    isStringArray(capabilities.process?.argv) &&
    isStringArray(capabilities.net?.hosts) &&
    isPositiveInteger(capabilities.limits?.timeoutMs) &&
    isPositiveInteger(capabilities.limits?.maxOutputBytes)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function capabilitiesKey(capabilities: ManifestCapabilities): string {
  return JSON.stringify({
    fs: { read: [...capabilities.fs.read], write: [...capabilities.fs.write] },
    process: { argv: [...capabilities.process.argv] },
    net: { hosts: [...capabilities.net.hosts] },
    limits: {
      timeoutMs: capabilities.limits.timeoutMs,
      maxOutputBytes: capabilities.limits.maxOutputBytes,
    },
  });
}

async function loadPackage(dir: string): Promise<ToolPackage> {
  const { loadToolPackage } = await import('../runtime/package.js');
  return loadToolPackage(dir);
}

async function sha256File(file: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const bytes = await fs.readFile(file);
  return createHash('sha256').update(bytes).digest('hex');
}

function validateExpectedSha(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw invalidArguments('expectSha256 must be a 64-character hex sha256');
  }
  return value.toLowerCase();
}

function normalizeApprovedBy(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidArguments('approvedBy must be a non-empty string when present');
  }
  return value.trim();
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidArguments(`${field} must be a non-empty string`);
  }
  return value;
}

function invalidArguments(message: string): ToolCreatorError {
  return new ToolCreatorError('invalid_arguments', message);
}

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split('\n')[0] ?? raw;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}

function isNotFound(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const difference = Number(x) - Number(y);
      if (difference !== 0) return difference < 0 ? -1 : 1;
      continue;
    }
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function versionParts(version: string): { core: number[]; pre: string[] } {
  const withoutBuild = version.split('+')[0] ?? version;
  const dash = withoutBuild.indexOf('-');
  const core = dash < 0 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash < 0 ? '' : withoutBuild.slice(dash + 1);
  return {
    core: core.split('.').map((part) => Number(part)),
    pre: pre === '' ? [] : pre.split('.'),
  };
}
