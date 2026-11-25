import type { Json, ToolManifest } from '../types.js';
import { describeCapabilities } from './capabilities.js';
import type { CapabilitySummary } from './capabilities.js';
import { installTool } from './install.js';
import type { InstalledTool } from './install.js';
import { ToolCreatorError as CoreToolCreatorError } from './prompt.js';
import { buildToolPrompt, resolveToolRequest } from './prompt.js';
import type { ToolCreatorCode as CoreToolCreatorCode, ToolRequest } from './prompt.js';
import { createToolProject } from './project.js';
import { formatSourceIssues, reviewToolSource } from './review.js';
import type { ToolSourceIssue, ToolSourceReport } from './review.js';
import { smokeTestTool } from './smoke.js';
import type { SmokeTestResult } from './smoke.js';

/**
 * The host glue: prompt -> injected model -> lint/repair -> project -> build ->
 * sandbox smoke test -> proposal, with installation behind an explicit call.
 *
 * This module is deliberately model-agnostic. It imports no provider, opens no
 * network connection and has no fallback model. `generate` is the host's own
 * callback.
 */

/** One model request. The prompts are provider-neutral text from `buildToolPrompt`. */
export interface ToolCreatorModelRequest {
  /** System prompt from `buildToolPrompt`. */
  system: string;
  /** User prompt from `buildToolPrompt`, with the repair note on a retry. */
  user: string;
  /** 1-based attempt counter. */
  attempt: number;
  /** Non-empty only on a retry: the issues the previous reply had to fix. */
  issues?: ToolSourceIssue[];
}

/** The host's model call. Throwing is fine; a thrown `AbortError` stays one. */
export type ToolCreatorGenerate = (request: ToolCreatorModelRequest) => Promise<string>;

export interface ToolCreatorOptions {
  /** Absolute workspace the smoke test runs against. */
  workspace: string;
  /** Where proposals are written. Default `<workspace>/.z2q/proposals`. */
  proposalDir?: string;
  /** The model call. Required. */
  generate: ToolCreatorGenerate;
  /** Generation attempts before giving up. Default 2, allowed 1-5. */
  maxAttempts?: number;
  /** Budget for one `generate` call. Default 120_000 ms. */
  timeoutMs?: number;
  /** Installed tools root handed to `installTool`. Default `<workspace>/.z2q/tools`. */
  toolsDir?: string;
  now?: () => number;
}

/** A reviewed, built and smoke-tested source awaiting a human install decision. */
export interface ToolProposal {
  readonly request: ToolRequest;
  readonly source: string;
  readonly projectDir: string;
  readonly manifest: ToolManifest;
  readonly sha256: string;
  readonly smoke: SmokeTestResult;
  readonly summary: CapabilitySummary;
  readonly attempts: number;
  /** What each failed attempt was told to fix. */
  readonly history: readonly { attempt: number; issues: readonly string[] }[];
}

/** Every error the flow can report. */
export type ToolCreatorCode =
  | 'invalid_request'
  | 'model_failed'
  | 'model_timeout'
  | 'model_aborted'
  | 'no_source'
  | 'review_failed'
  | 'build_failed'
  | 'smoke_failed'
  | 'install_failed';

export interface ToolCreatorErrorOptions {
  readonly issues?: readonly ToolSourceIssue[];
  readonly details?: Json;
  readonly report?: ToolSourceReport;
  readonly cause?: unknown;
}

/**
 * The same error object the rest of the creator uses, with the flow's extra
 * `issues` and `details` fields. The value below is the existing class, so
 * `instanceof ToolCreatorError` keeps working for every creator error.
 */
export interface ToolCreatorError extends Error {
  readonly code: ToolCreatorCode;
  readonly issues?: readonly ToolSourceIssue[];
  readonly details?: Json;
  readonly report?: ToolSourceReport;
}

export interface ToolCreatorErrorConstructor {
  new (
    code: ToolCreatorCode,
    message: string,
    options?: ToolCreatorErrorOptions,
  ): ToolCreatorError;
  readonly prototype: ToolCreatorError;
}

export const ToolCreatorError = CoreToolCreatorError as unknown as ToolCreatorErrorConstructor;

/**
 * The only function that writes a proposal or an installed tool.
 *
 * `propose` never writes into `toolsDir`. `install` is an explicit, human-owned
 * call and passes the proposal's sha256 to `installTool`.
 */
export class ToolCreator {
  readonly #workspace: string;
  readonly #proposalDir: string | undefined;
  readonly #generate: ToolCreatorGenerate;
  readonly #maxAttempts: number;
  readonly #timeoutMs: number;
  readonly #toolsDir: string | undefined;
  readonly #now: () => number;

  constructor(options: ToolCreatorOptions) {
    if (!isRecord(options)) {
      throw flowError('invalid_request', 'createToolCreator requires an options object');
    }
    this.#workspace = requireString(options.workspace, 'workspace');
    this.#proposalDir = optionalString(options.proposalDir, 'proposalDir');
    if (typeof options.generate !== 'function') {
      throw flowError('invalid_request', 'generate must be a function');
    }
    this.#generate = options.generate;
    this.#maxAttempts = integerInRange(options.maxAttempts, 2, 1, 5, 'maxAttempts');
    this.#timeoutMs = positiveInteger(options.timeoutMs, 120_000, 'timeoutMs');
    this.#toolsDir = optionalString(options.toolsDir, 'toolsDir');
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw flowError('invalid_request', 'now must be a function returning milliseconds');
    }
    this.#now = options.now ?? Date.now;
  }

  /**
   * Ask the model, lint the reply, retry once (by default) with the exact issues,
   * then write and smoke-test a project.
   *
   * The signal aborts a pending `generate` call and is checked before every
   * attempt and after every await. It cannot interrupt the synchronous QuickJS
   * smoke test; if it is aborted during that step, the abort is reported after
   * the step returns.
   */
  async propose(
    request: ToolRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ToolProposal> {
    if (!isRecord(options)) {
      throw flowError('invalid_request', 'propose options must be an object', {
        details: { field: 'options' },
      });
    }
    const signal = options.signal;
    if (
      signal !== undefined &&
      (typeof signal !== 'object' ||
        signal === null ||
        typeof (signal as AbortSignal).addEventListener !== 'function')
    ) {
      throw flowError('invalid_request', 'propose options.signal must be an AbortSignal', {
        details: { field: 'signal' },
      });
    }
    checkAbort(signal, 'before the first attempt');

    const resolved = resolveToolRequest(request);
    const prompt = buildToolPrompt(resolved);
    const history: { attempt: number; issues: readonly string[] }[] = [];
    let previousIssues: ToolSourceIssue[] | undefined;
    let finalSource: string | undefined;
    let attempts = 0;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      attempts = attempt;
      checkAbort(signal, 'before an attempt');

      const modelRequest: ToolCreatorModelRequest = {
        system: prompt.system,
        user:
          previousIssues === undefined
            ? prompt.user
            : repairUser(prompt.user, previousIssues),
        attempt,
        ...(previousIssues === undefined ? {} : { issues: [...previousIssues] }),
      };
      const reply = await this.#callGenerate(modelRequest, attempt, signal);
      checkAbort(signal, 'after the model reply');

      const source = extractToolSource(reply);
      if (source.length === 0) {
        throw flowError('no_source', 'the model reply did not contain a tool source file', {
          details: { attempt },
        });
      }

      const report = reviewToolSource(source);
      if (report.ok) {
        finalSource = source;
        break;
      }

      const told = report.issues.map((issue) => formatSourceIssues([issue]));
      history.push({ attempt, issues: told });
      if (attempt === this.#maxAttempts) {
        throw flowError(
          'review_failed',
          `the model did not produce a source that passes review after ${attempt} attempt(s): ${formatSourceIssues(report.issues)}`,
          { issues: report.issues, report },
        );
      }
      previousIssues = [...report.issues];
    }

    if (finalSource === undefined) {
      throw flowError('review_failed', 'the model did not produce a reviewed source');
    }

    checkAbort(signal, 'before writing the project');
    const path = await import('node:path');
    const workspace = path.resolve(this.#workspace);
    const proposalRoot = path.resolve(
      this.#proposalDir ?? path.join(workspace, '.z2q', 'proposals'),
    );
    const at = this.nowValue();
    const projectDir = path.join(
      proposalRoot,
      `${resolved.name}-${attempts}-${Math.trunc(at)}`,
    );

    let project;
    try {
      project = await createToolProject({
        dir: projectDir,
        request: resolved,
        source: finalSource,
      });
    } catch (error) {
      if (
        error instanceof ToolCreatorError &&
        (error as { code?: string }).code === 'name_mismatch'
      ) {
        // A model that renames the tool is a review problem, not a build crash:
        // the host reads `issues` to decide whether to retry.
        throw flowError('review_failed', messageOf(error), {
          issues: [{ code: 'name_mismatch', message: messageOf(error), line: 1 }],
          cause: error,
        });
      }
      throw flowError('build_failed', `project build failed: ${messageOf(error)}`, {
        cause: error,
      });
    }
    checkAbort(signal, 'after writing the project');

    const bundle = path.join(project.dir, 'dist', 'index.js');
    let sha256: string;
    try {
      sha256 = await sha256File(bundle);
    } catch (error) {
      throw flowError('build_failed', `cannot hash dist/index.js: ${messageOf(error)}`, {
        cause: error,
      });
    }
    checkAbort(signal, 'after hashing the bundle');

    let smoke: SmokeTestResult;
    try {
      smoke = await smokeTestTool(project.dir, {
        workspace,
        request: resolved,
      });
    } catch (error) {
      throw flowError('build_failed', `smoke setup failed: ${messageOf(error)}`, {
        cause: error,
      });
    }
    checkAbort(signal, 'after the smoke test');

    if (!smoke.ok) {
      throw flowError(
        'smoke_failed',
        `the smoke test failed: ${formatSmoke(smoke)}`,
        { details: { runs: smoke.runs } as unknown as Json },
      );
    }

    return {
      request: resolved,
      source: finalSource,
      projectDir: project.dir,
      manifest: project.manifest,
      sha256,
      smoke,
      summary: describeCapabilities(project.manifest),
      attempts,
      history,
    };
  }

  /**
   * Install a proposal behind `approval.json`.
   *
   * The proposal's sha256 is authoritative: it is the artefact the smoke test
   * ran. `expectSha256` is a second expectation and can only tighten — a value
   * that differs from the proposal's is refused instead of overriding it. Before
   * delegating, the current `dist/index.js` is re-hashed: a proposal changed
   * after its smoke test is refused instead of being silently rebuilt by
   * `installTool`.
   */
  async install(
    proposal: ToolProposal,
    options: { approvedBy?: string; expectSha256?: string } = {},
  ): Promise<InstalledTool> {
    if (!isRecord(proposal) || typeof proposal.projectDir !== 'string' || typeof proposal.sha256 !== 'string') {
      throw flowError('install_failed', 'install requires a proposal made by propose()', {
        details: { code: 'invalid_arguments' },
      });
    }
    if (!isRecord(options)) {
      throw flowError('install_failed', 'install options must be an object', {
        details: { code: 'invalid_arguments' },
      });
    }
    if (options.expectSha256 !== undefined && options.expectSha256 !== proposal.sha256) {
      // The proposal's hash is authoritative: it is the artefact the smoke test
      // ran. `expectSha256` is a second, stricter expectation, not an override.
      throw flowError(
        'install_failed',
        `sha_mismatch: the caller expects ${String(options.expectSha256)}, but the proposal was smoke-tested as ${proposal.sha256}`,
        { details: { code: 'sha_mismatch' } },
      );
    }

    const path = await import('node:path');
    const workspace = path.resolve(this.#workspace);
    const toolsDir = path.resolve(
      this.#toolsDir ?? path.join(workspace, '.z2q', 'tools'),
    );
    const expectedSha = options.expectSha256 ?? proposal.sha256;
    const bundle = path.join(proposal.projectDir, 'dist', 'index.js');

    let currentSha: string;
    try {
      currentSha = await sha256File(bundle);
    } catch (error) {
      throw flowError(
        'install_failed',
        `sha_mismatch: cannot read the proposal bundle: ${messageOf(error)}`,
        { details: { code: 'sha_mismatch' }, cause: error },
      );
    }
    if (currentSha !== proposal.sha256) {
      throw flowError(
        'install_failed',
        `sha_mismatch: dist/index.js changed after the smoke test (${currentSha} != ${proposal.sha256})`,
        { details: { code: 'sha_mismatch' } },
      );
    }

    try {
      return await installTool({
        toolsDir,
        dir: proposal.projectDir,
        ...(options.approvedBy === undefined ? {} : { approvedBy: options.approvedBy }),
        expectSha256: expectedSha,
        now: this.#now,
      });
    } catch (error) {
      const originalCode =
        error instanceof CoreToolCreatorError ? (error as { code?: unknown }).code : undefined;
      const code = typeof originalCode === 'string' ? originalCode : 'unknown';
      const detail = messageOf(error);
      const message =
        code === 'sha_mismatch' ? `sha_mismatch: ${detail}` : `${code}: ${detail}`;
      throw flowError('install_failed', message, {
        details: { code },
        cause: error,
      });
    }
  }

  async #callGenerate(
    request: ToolCreatorModelRequest,
    attempt: number,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (signal?.aborted === true) {
      throw aborted('before the model call');
    }

    const generation = Promise.resolve().then(() => this.#generate(request));
    // A loser must not reject later: the timeout/abort branch owns the error.
    void generation.catch(() => undefined);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          flowError(
            'model_timeout',
            `the model call exceeded ${this.#timeoutMs} ms on attempt ${attempt}`,
            { details: { attempt } },
          ),
        );
      }, this.#timeoutMs);
    });

    let onAbort: (() => void) | undefined;
    const listeners: Promise<string>[] = [generation, timeout];
    if (signal !== undefined) {
      const abortedPromise = new Promise<never>((_, reject) => {
        onAbort = () => reject(aborted('during the model call'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      listeners.push(abortedPromise);
    }

    try {
      return await Promise.race(listeners);
    } catch (error) {
      if (isAbortError(error)) {
        throw aborted('during the model call');
      }
      if (isFlowCode(error, 'model_timeout') || isFlowCode(error, 'model_aborted')) {
        throw error;
      }
      throw flowError(
        'model_failed',
        `the model call failed on attempt ${attempt}: ${messageOf(error)}`,
        { cause: error, details: { attempt } },
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal !== undefined && onAbort !== undefined) {
        if (typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
      }
    }
  }

  private nowValue(): number {
    let value: number;
    try {
      value = this.#now();
    } catch (error) {
      throw flowError('invalid_request', `now threw: ${messageOf(error)}`, {
        cause: error,
      });
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw flowError('invalid_request', 'now must return a finite number of milliseconds');
    }
    return value;
  }
}

/** Create the host glue. Nothing is written until `propose` or `install` is called. */
export function createToolCreator(options: ToolCreatorOptions): ToolCreator {
  return new ToolCreator(options);
}

function repairUser(user: string, issues: readonly ToolSourceIssue[]): string {
  return `${user}\n\nYour previous reply was rejected by the static review. Fix exactly these issues and reply with the complete corrected file only:\n${issues
    .map((issue) => formatSourceIssues([issue]))
    .join('\n')}`;
}

/**
 * Extract source without evaluating it.
 *
 * The first fenced block containing `defineTool` wins. If there are fences but
 * none contains `defineTool`, the reply is not a source. A bare reply is
 * accepted when it contains `defineTool`; an ordinary prose reply is not.
 */
function extractToolSource(reply: unknown): string {
  if (typeof reply !== 'string') return '';
  const text = reply.trim();
  if (text.length === 0) return '';

  const fence = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
  let foundFence = false;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    foundFence = true;
    const block = stripFilenameLine(match[2] ?? '');
    if (block.includes('defineTool')) return block;
  }
  if (foundFence) return '';

  const bare = stripFilenameLine(text);
  return bare.includes('defineTool') ? bare : '';
}

function stripFilenameLine(block: string): string {
  const lines = block.split(/\r?\n/);
  const first = lines[0]?.trim() ?? '';
  if (/^(?:\/\/|#)?\s*[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(first)) {
    lines.shift();
  }
  return lines.join('\n').trim();
}

function checkAbort(signal: AbortSignal | undefined, when: string): void {
  if (signal?.aborted === true) throw aborted(when);
}

function aborted(when: string): ToolCreatorError {
  return flowError('model_aborted', `the model call was aborted by the caller (${when})`);
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { name?: unknown; code?: unknown };
  return record.name === 'AbortError' || record.code === 'ABORT_ERR';
}

function isFlowCode(error: unknown, code: string): boolean {
  return (
    error instanceof CoreToolCreatorError &&
    (error as { code?: unknown }).code === code
  );
}

function flowError(
  code: ToolCreatorCode,
  message: string,
  options: ToolCreatorErrorOptions = {},
): ToolCreatorError {
  const report =
    options.report ??
    (code === 'review_failed' && options.issues !== undefined
      ? { ok: false, issues: [...options.issues] }
      : undefined);
  const error = new CoreToolCreatorError(
    code as unknown as CoreToolCreatorCode,
    oneLine(message),
    {
      ...(report === undefined ? {} : { report }),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    },
  ) as ToolCreatorError;
  if (options.issues !== undefined) {
    Object.assign(error, { issues: options.issues });
  }
  if (options.details !== undefined) {
    Object.assign(error, { details: options.details });
  }
  return error;
}

async function sha256File(file: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const bytes = await fs.readFile(file);
  return createHash('sha256').update(bytes).digest('hex');
}

function formatSmoke(smoke: SmokeTestResult): string {
  return smoke.runs
    .map(
      (run, index) =>
        `run ${index + 1}: ${run.code ?? (run.denied > 0 ? 'denied' : 'tool_threw')}${run.message === undefined ? '' : `: ${run.message}`}`,
    )
    .join('; ');
}

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return oneLine(raw);
}

function oneLine(message: string): string {
  return message.split(/\r?\n/, 1)[0] ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw flowError('invalid_request', `${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function positiveInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw flowError('invalid_request', `${field} must be a positive integer`);
  }
  return value;
}

function integerInRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const resolved = positiveInteger(value, fallback, field);
  if (resolved < minimum || resolved > maximum) {
    throw flowError(
      'invalid_request',
      `${field} must be between ${minimum} and ${maximum}`,
    );
  }
  return resolved;
}
