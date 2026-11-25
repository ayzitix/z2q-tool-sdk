import type { ToolManifest } from './types.js';

/**
 * Structural manifest check shared by `buildTool`, `packTool` and the runtime.
 *
 * It validates the *shape* the SDK writes to `tool.json`, not the tool's own
 * business rules: a hand-edited manifest with an odd description is still a
 * manifest. Callers add their own error wording around it.
 */
export function isToolManifest(value: unknown): value is ToolManifest {
  if (typeof value !== 'object' || value === null) return false;
  const manifest = value as Partial<ToolManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    !nonEmptyString(manifest.name) ||
    !nonEmptyString(manifest.version) ||
    typeof manifest.description !== 'string' ||
    typeof manifest.parameters !== 'object' ||
    manifest.parameters === null ||
    typeof manifest.capabilities !== 'object' ||
    manifest.capabilities === null
  ) {
    return false;
  }
  const capabilities = manifest.capabilities as {
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

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
