import type { ManifestCapabilities, ToolManifest } from '../types.js';

/** The risk class an approval prompt shows. Ordered by severity. */
export type CapabilityRisk = 'read-only' | 'writes' | 'runs-programs' | 'network';

/** A human-readable capability summary for an approval prompt. */
export interface CapabilitySummary {
  /** Human sentences, one per granted surface. */
  lines: string[];
  risk: CapabilityRisk;
}

/**
 * Describe what a manifest asks for, in sentences a person can approve.
 *
 * The summary only reads the manifest: it never grants, opens or runs anything.
 * Patterns are JSON-quoted so a grant containing a newline or a quote cannot
 * break the approval prompt into extra lines.
 */
export function describeCapabilities(manifest: ToolManifest): CapabilitySummary {
  const capabilities = manifest.capabilities;
  const lines: string[] = [];

  if (capabilities.fs.read.length > 0) {
    lines.push(`Reads workspace files matching ${quoted(capabilities.fs.read)}.`);
  }
  if (capabilities.fs.write.length > 0) {
    lines.push(`Writes workspace files matching ${quoted(capabilities.fs.write)}.`);
  }
  if (capabilities.process.argv.length === 1) {
    lines.push(`Runs the program ${quoted(capabilities.process.argv)} (argv only, never a shell).`);
  } else if (capabilities.process.argv.length > 1) {
    lines.push(
      `Runs these programs (argv only, never a shell): ${quoted(capabilities.process.argv)}.`,
    );
  }
  if (capabilities.net.hosts.length > 0) {
    lines.push(
      `Requests network hosts ${quoted(capabilities.net.hosts)}; the runtime does not support net.fetch today.`,
    );
  }
  if (lines.length === 0) {
    lines.push('No filesystem, process or network grants.');
  }

  lines.push(`Stops a call after ${capabilities.limits.timeoutMs} ms.`);
  lines.push(
    `Captures at most ${capabilities.limits.maxOutputBytes} bytes of stdout/stderr per call.`,
  );

  return { lines, risk: riskOf(capabilities) };
}

function riskOf(capabilities: ManifestCapabilities): CapabilityRisk {
  if (capabilities.net.hosts.length > 0) return 'network';
  if (capabilities.process.argv.length > 0) return 'runs-programs';
  if (capabilities.fs.write.length > 0) return 'writes';
  return 'read-only';
}

function quoted(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(', ');
}
