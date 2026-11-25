import type { Json } from '../types.js';

/** Every failure the sandbox runtime can report, as an exact string. */
export type ToolRuntimeCode =
  | 'invalid_tool'
  | 'invalid_arguments'
  | 'invalid_output'
  | 'capability_denied'
  | 'path_outside_workspace'
  | 'path_denied'
  | 'secret_path_denied'
  | 'process_argv_denied'
  | 'process_failed'
  | 'process_timeout'
  | 'net_not_supported'
  | 'time_limit'
  | 'memory_limit'
  | 'loop_limit'
  | 'output_too_large'
  | 'tool_threw'
  | 'audit_limit';

export const TOOL_RUNTIME_CODES: readonly ToolRuntimeCode[] = [
  'invalid_tool',
  'invalid_arguments',
  'invalid_output',
  'capability_denied',
  'path_outside_workspace',
  'path_denied',
  'secret_path_denied',
  'process_argv_denied',
  'process_failed',
  'process_timeout',
  'net_not_supported',
  'time_limit',
  'memory_limit',
  'loop_limit',
  'output_too_large',
  'tool_threw',
  'audit_limit',
];

export interface ToolRuntimeErrorOptions {
  tool?: string;
  details?: Json;
  cause?: unknown;
}

/**
 * Raised by the sandbox runtime. `message` is the human detail only; `code`
 * carries the machine-readable reason and survives the trip out of QuickJS.
 */
export class ToolRuntimeError extends Error {
  readonly code: ToolRuntimeCode;
  readonly tool?: string;
  readonly details?: Json;

  constructor(code: ToolRuntimeCode, message: string, options: ToolRuntimeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ToolRuntimeError';
    this.code = code;
    if (options.tool !== undefined) this.tool = options.tool;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** True when `value` is one of the 17 documented codes. */
export function isToolRuntimeCode(value: unknown): value is ToolRuntimeCode {
  return typeof value === 'string' && (TOOL_RUNTIME_CODES as readonly string[]).includes(value);
}

/**
 * Read the leading `code:` of a message thrown inside the VM.
 *
 * The shim and the broker both use `Error('<code>: <detail>')` so the host can
 * recover the code after the error has crossed the QuickJS boundary, where only
 * `name` and `message` survive.
 */
export function codeFromMessage(message: string): ToolRuntimeCode | undefined {
  const match = /^([a-z][a-z0-9_]*):\s+([\s\S]*)$/.exec(message);
  if (match === null) return undefined;
  const code = match[1] ?? '';
  return isToolRuntimeCode(code) ? code : undefined;
}

/** Strip a leading `code: ` prefix, if the message has one. */
export function detailFromMessage(message: string): string {
  const match = /^([a-z][a-z0-9_]*):\s+([\s\S]*)$/.exec(message);
  if (match === null) return message;
  return isToolRuntimeCode(match[1] ?? '') ? (match[2] ?? '') : message;
}
