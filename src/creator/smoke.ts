import { toPlainJson } from '../schema.js';
import type { Json } from '../types.js';
import { ToolCreatorError } from './prompt.js';
import type { ToolRequest } from './prompt.js';
import { buildToolProject, formatSourceIssues, reviewToolSource } from './review.js';

export interface SmokeTestOptions {
  /** A temp dir the test owns; every fs grant is relative to it. */
  workspace: string;
  /** One run per entry; defaults to `request.examples` or `[{}]`. */
  args?: Json[];
  timeoutMs?: number;
  /**
   * Optional source of sample inputs. The brief's `SmokeTestOptions` has no
   * request field, so callers pass examples explicitly; this field lets the
   * creator use `request.examples` without a separate lookup.
   */
  request?: ToolRequest;
  /** Let a denial pass the sample; the run still reports `denied` and `codes`. */
  allowDenials?: boolean;
}

export interface SmokeTestRun {
  args: Json;
  ok: boolean;
  value?: Json;
  code?: string;
  message?: string;
  /** Deny rows from the runtime audit for this run. */
  denied: number;
  /** Unique runtime codes among those deny rows. */
  codes: string[];
  durationMs: number;
}

export interface SmokeTestResult {
  ok: boolean;
  runs: SmokeTestRun[];
}

/**
 * Build the package, then run every sample through `createToolRuntime` with the
 * manifest's own grants.
 *
 * A source that fails static review is never built. The build reads its
 * definition inside QuickJS, so the review is an early warning, not the
 * boundary. Setup failures (missing source or dist, a bad workspace) throw; a
 * failing sample is reported in `runs`, never thrown.
 */
export async function smokeTestTool(
  dir: string,
  options: SmokeTestOptions,
): Promise<SmokeTestResult> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  if (typeof dir !== 'string' || dir.length === 0) {
    throw invalidArguments('smokeTestTool requires a tool directory');
  }
  if (typeof options !== 'object' || options === null) {
    throw invalidArguments('smokeTestTool requires an options object');
  }
  const workspace = requireString(options.workspace, 'workspace');
  const inputs = resolveInputs(options);
  const timeoutMs = options.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0)
  ) {
    throw invalidArguments('timeoutMs must be a positive integer');
  }
  if (options.allowDenials !== undefined && typeof options.allowDenials !== 'boolean') {
    throw invalidArguments('allowDenials must be a boolean when present');
  }
  const allowDenials = options.allowDenials === true;

  const root = path.resolve(dir);
  const entry = path.join(root, 'tool.ts');
  const entryInfo = await fs.stat(entry).catch(() => undefined);
  if (entryInfo?.isFile() === true) {
    const source = await fs.readFile(entry, 'utf8');
    const report = reviewToolSource(source);
    if (!report.ok) {
      throw new ToolCreatorError(
        'invalid_source',
        `source failed review: ${formatSourceIssues(report.issues)}`,
        { report },
      );
    }
    try {
      await buildToolProject(root);
    } catch (error) {
      throw new ToolCreatorError('build_failed', messageOf(error), { cause: error });
    }
  } else if (!(await hasBuiltPackage(root))) {
    throw new ToolCreatorError(
      'missing_entry',
      `missing tool.ts in ${root}; nothing to build or load`,
    );
  }

  const { createToolRuntime, ToolRuntimeError } = await import('../runtime/index.js');
  const runtime = await createToolRuntime({ workspace: path.resolve(workspace) });
  const runs: SmokeTestRun[] = [];
  for (const input of inputs) {
    const started = Date.now();
    try {
      const result = await runtime.run(
        root,
        input,
        timeoutMs === undefined ? {} : { timeoutMs },
      );
      const denials = result.audit.filter((row) => row.decision === 'deny');
      const codes = uniqueCodes(denials.map((row) => row.code));
      runs.push({
        args: input,
        ok: allowDenials || denials.length === 0,
        value: result.value,
        denied: denials.length,
        codes,
        durationMs: Math.max(0, Date.now() - started),
      });
    } catch (error) {
      const code =
        error instanceof ToolRuntimeError ? error.code : 'tool_threw';
      const denied = isDenialCode(code) ? 1 : 0;
      runs.push({
        args: input,
        ok: false,
        code,
        message: messageOf(error),
        denied,
        codes: denied === 1 ? [code] : [],
        durationMs: Math.max(0, Date.now() - started),
      });
    }
  }
  return { ok: runs.every((run) => run.ok), runs };
}

function resolveInputs(options: SmokeTestOptions): Json[] {
  if (options.args !== undefined) {
    if (!Array.isArray(options.args)) {
      throw invalidArguments('args must be an array of JSON inputs');
    }
    return options.args.map((value, index) => toPlainJson(value, `args[${index}]`));
  }
  const examples = options.request?.examples;
  if (examples !== undefined) {
    if (!Array.isArray(examples)) {
      throw invalidArguments('request.examples must be an array');
    }
    return examples.map((example, index) =>
      toPlainJson(example.input, `request.examples[${index}].input`),
    );
  }
  return [{}];
}

async function hasBuiltPackage(root: string): Promise<boolean> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  for (const file of ['tool.json', 'index.js']) {
    const info = await fs.stat(path.join(root, 'dist', file)).catch(() => undefined);
    if (info?.isFile() !== true) return false;
  }
  return true;
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

const DENIAL_CODES = new Set([
  'capability_denied',
  'path_outside_workspace',
  'path_denied',
  'secret_path_denied',
  'process_argv_denied',
  'net_not_supported',
]);

function isDenialCode(code: string): boolean {
  return DENIAL_CODES.has(code);
}

function uniqueCodes(codes: readonly (string | undefined)[]): string[] {
  return [...new Set(codes.filter((code): code is string => code !== undefined))];
}

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split('\n')[0] ?? raw;
}
