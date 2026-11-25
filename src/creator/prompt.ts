import { toPlainJson } from '../schema.js';
import type { Capabilities, Json } from '../types.js';
import type { ToolSourceReport } from './review.js';

/** Everything the creator can refuse, as an exact string. */
export type ToolCreatorCode =
  | 'invalid_request'
  | 'invalid_arguments'
  | 'invalid_source'
  | 'invalid_name'
  | 'invalid_version'
  | 'project_not_empty'
  | 'missing_entry'
  | 'missing_dist'
  | 'build_failed'
  | 'name_mismatch'
  | 'version_exists'
  | 'sha_mismatch'
  | 'capabilities_mismatch'
  | 'invalid_approval'
  | 'not_installed'
  | 'network_not_supported'
  | 'limit_too_large'
  | 'invalid_fs_grant'
  | 'invalid_argv_grant';

/**
 * Raised by the Tool Creator. `message` is the human detail; `code` is stable
 * and survives to the CLI, which prints it the same way it prints a runtime
 * code. A refusal that came from source review carries the report.
 */
export class ToolCreatorError extends Error {
  readonly code: ToolCreatorCode;
  readonly report?: ToolSourceReport;

  constructor(
    code: ToolCreatorCode,
    message: string,
    options: { report?: ToolSourceReport; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ToolCreatorError';
    this.code = code;
    if (options.report !== undefined) this.report = options.report;
  }
}

/** What a host asks the creator to build. The model call is the host's job. */
export interface ToolRequest {
  /** 3-64 chars, `tool.<slug>` recommended; the creator normalises `find todos` -> `tool.find-todos`. */
  name: string;
  /** One or two sentences: what the tool does. */
  purpose: string;
  /** Optional sample inputs a smoke test can run. */
  examples?: { input: Json; note?: string }[];
  /** Optional hint about what the tool will need; the generated code still decides. */
  capabilitiesHint?: Capabilities;
}

/** A provider-neutral prompt pair. Nothing here depends on a model vendor. */
export interface ToolPrompt {
  system: string;
  user: string;
}

const NAME_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MIN_NAME_LENGTH = 3;
const MAX_PURPOSE_LENGTH = 2000;

const EXAMPLE_PROMPT_SOURCE = `import { defineTool } from 'z1-tool-sdk';
import { z } from 'zod';

export const tool = defineTool({
  name: 'tool.count-lines',
  version: '0.1.0',
  description: 'Count the lines in workspace files that match a glob.',
  parameters: z.object({
    glob: z.string().default('**/*').describe('Workspace-relative files to scan.'),
  }),
  capabilities: {
    fs: { read: ['**/*'] },
    limits: { timeoutMs: 10000 },
  },
  run: async (ctx, args) => {
    const files = await ctx.fs.glob(args.glob);
    let lines = 0;
    for (const path of files) {
      const text = await ctx.fs.read(path);
      lines += text === '' ? 0 : text.split('\\n').length;
    }
    return { files: files.length, lines };
  },
});`;

const SYSTEM_PROMPT = `You write one z1 tool as a single TypeScript file. Reply with the file contents and nothing else.

## Contract

import { defineTool } from 'z1-tool-sdk';
import { z } from 'zod';

export const tool = defineTool({
  name: 'tool.example',
  version: '0.1.0',
  description: 'One or two sentences, at least 20 characters.',
  parameters: z.object({ /* ... */ }),
  capabilities: { /* ... */ },
  run: async (ctx, args) => {
    return { /* plain JSON */ };
  },
});

- name: 3-64 characters, lowercase, matching ^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$.
- version: strict semver, for example 0.1.0.
- description: 20-500 characters, describing what the tool does.
- parameters: a zod 4 object schema; it becomes draft-2020-12 JSON Schema.
- capabilities: required even when empty. It is a declaration; the runtime decides what to grant.
- run: async (ctx, args) => Promise<Json>; return plain JSON only.

## The context

ctx.workspace is the absolute workspace root (a read-only string).
ctx.fs.read(path) returns a workspace-relative file as a string.
ctx.fs.write(path, data) writes a workspace-relative file.
ctx.fs.list(path) returns directory entries.
ctx.fs.glob(pattern) returns workspace-relative paths; only "*", "**" and "?" are special.
ctx.fs.grep(pattern, { glob, ignoreCase }) returns { path, line, text } matches.
ctx.process.run({ argv: ['git', 'status'], cwd, env, stdin }) returns { code, stdout, stderr }.
  argv is an executable plus arguments, never a shell string; argv[0] must be granted.
ctx.log(level, message) writes to the host log.
ctx.signal is a frozen { aborted: false }; the VM cannot observe an abort mid-call.
There is no network: ctx.net.fetch always fails, and net capabilities are refused.

## Capabilities are declarations

fs.read and fs.write: workspace-relative globs. Never absolute, never "..".
process.argv: bare executable names such as "git". Never a path, never a flag.
limits.timeoutMs: at most 60000 (default 30000).
limits.maxOutputBytes: at most 8388608 (default 1048576).
net: not supported. Do not declare it, not even with an empty host list.

## Rules

- Import only 'z1-tool-sdk' and 'zod'. No 'node:' imports, no relative imports, no require,
  and no dynamic import() except a literal import('zod').
- Never use process, require, eval, Function, globalThis, Deno, Bun, child_process,
  worker_threads, net, http, https, dns, tls, dgram, os, v8, Atomics, SharedArrayBuffer
  or WebAssembly. Strings and comments are not identifiers, but do not rely on that:
  use ctx for every host capability.
- No Node builtins, no fetch, no timers, no global state, no network. Use ctx.
- Keep the whole file under 32 KiB.
- The tool must be deterministic and return JSON-serializable values.`;

/**
 * Normalise a requested name. A valid name is returned unchanged; anything else
 * becomes `tool.<slug>` (`find todos` -> `tool.find-todos`). Throws
 * `ToolCreatorError` with `invalid_request` when no usable name remains.
 */
export function normalizeToolName(input: string): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new ToolCreatorError('invalid_request', 'tool name must be a non-empty string');
  }
  const trimmed = input.trim().toLowerCase();
  if (
    trimmed.length >= MIN_NAME_LENGTH &&
    trimmed.length <= MAX_NAME_LENGTH &&
    NAME_PATTERN.test(trimmed)
  ) {
    return trimmed;
  }

  const parts = trimmed.split(/[^a-z0-9]+/).filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new ToolCreatorError(
      'invalid_request',
      `tool name must contain letters or digits, got "${input}"`,
    );
  }
  const body = parts[0] === 'tool' ? parts.slice(1) : parts;
  if (body.length === 0) {
    return 'tool';
  }
  let candidate = `tool.${body.join('-')}`;
  if (candidate.length > MAX_NAME_LENGTH) {
    candidate = candidate.slice(0, MAX_NAME_LENGTH).replace(/[.-]+$/, '');
  }
  if (candidate.length < MIN_NAME_LENGTH || !NAME_PATTERN.test(candidate)) {
    throw new ToolCreatorError(
      'invalid_request',
      `tool name could not be normalised to 3-64 characters, got "${input}"`,
    );
  }
  return candidate;
}

/** True when `value` is a valid tool name (the same pattern `defineTool` uses). */
export function isValidToolName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= MIN_NAME_LENGTH &&
    value.length <= MAX_NAME_LENGTH &&
    NAME_PATTERN.test(value)
  );
}

/** Resolve and validate a request, returning a normalised copy. */
export function resolveToolRequest(request: ToolRequest): ToolRequest {
  if (typeof request !== 'object' || request === null) {
    throw new ToolCreatorError('invalid_request', 'tool request must be an object');
  }
  const name = normalizeToolName(request.name);
  if (typeof request.purpose !== 'string' || request.purpose.trim().length === 0) {
    throw new ToolCreatorError('invalid_request', 'purpose must be a non-empty string');
  }
  const purpose = request.purpose.trim();
  if (purpose.length > MAX_PURPOSE_LENGTH) {
    throw new ToolCreatorError(
      'invalid_request',
      `purpose must be at most ${MAX_PURPOSE_LENGTH} characters, got ${purpose.length}`,
    );
  }

  const resolved: ToolRequest = { name, purpose };
  if (request.examples !== undefined) {
    if (!Array.isArray(request.examples)) {
      throw new ToolCreatorError('invalid_request', 'examples must be an array');
    }
    resolved.examples = request.examples.map((example, index) => {
      if (typeof example !== 'object' || example === null || !('input' in example)) {
        throw new ToolCreatorError(
          'invalid_request',
          `examples[${index}] must be an object with an "input" value`,
        );
      }
      if (example.note !== undefined && typeof example.note !== 'string') {
        throw new ToolCreatorError('invalid_request', `examples[${index}].note must be a string`);
      }
      const input = toPlainJson(example.input, `examples[${index}].input`);
      return example.note === undefined ? { input } : { input, note: example.note };
    });
  }
  if (request.capabilitiesHint !== undefined) {
    const hint = toPlainJson(request.capabilitiesHint, 'capabilitiesHint');
    if (typeof hint !== 'object' || hint === null || Array.isArray(hint)) {
      throw new ToolCreatorError('invalid_request', 'capabilitiesHint must be an object');
    }
    resolved.capabilitiesHint = hint as Capabilities;
  }
  return resolved;
}

/**
 * Build the provider-neutral prompt pair for a request.
 *
 * The system prompt states the SDK contract, the context surface and the hard
 * limits the static reviewer enforces. The user prompt carries the request, its
 * examples and a complete worked example. Both are deterministic plain text.
 */
export function buildToolPrompt(request: ToolRequest): ToolPrompt {
  const resolved = resolveToolRequest(request);
  const lines = [
    `Build the tool "${resolved.name}".`,
    '',
    '## Purpose',
    '',
    resolved.purpose,
    '',
    '## Examples',
    '',
  ];

  const examples = resolved.examples ?? [];
  if (examples.length === 0) {
    lines.push('None supplied. Choose a sensible default input such as {}.');
  } else {
    examples.forEach((example, index) => {
      lines.push(`${index + 1}. input: ${JSON.stringify(example.input, null, 2)}`);
      if (example.note !== undefined) lines.push(`   note: ${example.note}`);
    });
  }

  lines.push('', '## Capabilities hint', '');
  if (resolved.capabilitiesHint === undefined) {
    lines.push('None supplied. Decide from the code, and declare only what it uses.');
  } else {
    lines.push(
      'The host suggests the following, but the generated code still decides:',
      '',
      JSON.stringify(resolved.capabilitiesHint, null, 2),
    );
  }

  lines.push(
    '',
    '## Worked example',
    '',
    EXAMPLE_PROMPT_SOURCE,
    '',
    `Write the complete tool.ts for "${resolved.name}". Return only the file contents.`,
    '',
  );

  return { system: SYSTEM_PROMPT, user: lines.join('\n') };
}
