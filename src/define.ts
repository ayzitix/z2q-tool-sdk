import type { z } from 'zod';
import { isZodObject, zodObjectToJsonSchema } from './schema.js';
import type {
  Capabilities,
  DefineToolOptions,
  Json,
  ToolContext,
  ToolDefinition,
  ToolManifest,
  ManifestCapabilities,
} from './types.js';

export type ToolDefinitionErrorCode =
  | 'INVALID_DEFINITION'
  | 'INVALID_RUN'
  | 'INVALID_NAME'
  | 'INVALID_VERSION'
  | 'INVALID_DESCRIPTION'
  | 'INVALID_PARAMETERS'
  | 'INVALID_CAPABILITIES';

/** Raised when a tool definition is malformed. Never raised for tool arguments. */
export class ToolDefinitionError extends Error {
  readonly code: ToolDefinitionErrorCode;
  readonly field: string;

  constructor(code: ToolDefinitionErrorCode, field: string, message: string) {
    super(message);
    this.name = 'ToolDefinitionError';
    this.code = code;
    this.field = field;
  }
}

/** Raised by `runTool` when arguments do not match the tool's zod schema. */
export class ToolArgumentError extends Error {
  readonly tool: string;
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(tool: string, issues: readonly z.core.$ZodIssue[]) {
    const detail = issues
      .map(
        (issue) =>
          `${issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'}: ${issue.message}`,
      )
      .join('; ');
    super(`invalid arguments for ${tool}: ${detail}`);
    this.name = 'ToolArgumentError';
    this.tool = tool;
    this.issues = issues;
  }
}

const NAME_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const MAX_DESCRIPTION_LENGTH = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

const CAPABILITIES_KEYS = ['fs', 'process', 'net', 'env', 'limits'] as const;
const FS_KEYS = ['read', 'write'] as const;
const PROCESS_KEYS = ['argv'] as const;
const NET_KEYS = ['hosts'] as const;
const ENV_KEYS = ['read'] as const;
const LIMIT_KEYS = ['timeoutMs', 'maxOutputBytes'] as const;
/** The same shape the runtime enforces on `capabilities.env.read`. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate a tool name. Exported for the CLI's `init` command. */
export function assertToolName(name: unknown): asserts name is string {
  if (typeof name !== 'string') {
    throw defineError('INVALID_NAME', 'name', 'name must be a string');
  }
  if (name.length < 3 || name.length > 64) {
    throw defineError(
      'INVALID_NAME',
      'name',
      `name must be 3-64 characters, got ${name.length}`,
    );
  }
  if (!NAME_PATTERN.test(name)) {
    throw defineError(
      'INVALID_NAME',
      'name',
      `name must match ${NAME_PATTERN.source} (lowercase, dots and dashes, e.g. tool.my-tool), got "${name}"`,
    );
  }
}

/**
 * Define a z1 tool.
 *
 * This validates the definition, normalizes capabilities and produces a frozen
 * plain-JSON manifest. It never runs the tool and never grants anything.
 */
export function defineTool<Shape extends z.ZodRawShape>(
  options: DefineToolOptions<Shape>,
): ToolDefinition<Shape> {
  if (!isRecord(options)) {
    throw defineError('INVALID_DEFINITION', 'options', 'defineTool expects an options object');
  }

  assertToolName(options.name);
  const version = validateVersion(options.version);
  const description = validateDescription(options.description);
  const parameters = options.parameters as unknown;

  if (!isZodObject(parameters)) {
    throw defineError(
      'INVALID_PARAMETERS',
      'parameters',
      'parameters must be a zod 4 object schema created with z.object({...})',
    );
  }
  if (typeof options.run !== 'function') {
    throw defineError('INVALID_RUN', 'run', 'run must be a function');
  }

  const capabilities = resolveCapabilities(options.capabilities);
  const manifest: ToolManifest = {
    schemaVersion: 1,
    name: options.name,
    version,
    description,
    parameters: parametersToJsonSchema(parameters),
    capabilities,
  };
  deepFreeze(manifest);

  return {
    manifest,
    parameters: options.parameters,
    run: options.run,
  };
}

/**
 * Validate `args` against the tool schema, then call the tool. Hosts and tests
 * should prefer this over `tool.run`, which trusts its arguments.
 */
export async function runTool<Shape extends z.ZodRawShape>(
  tool: ToolDefinition<Shape>,
  args: unknown,
  ctx: ToolContext,
): Promise<Json> {
  const parsed = tool.parameters.safeParse(args);
  if (!parsed.success) {
    throw new ToolArgumentError(tool.manifest.name, parsed.error.issues);
  }
  return tool.run(ctx, parsed.data);
}

function parametersToJsonSchema(
  parameters: z.ZodObject<z.ZodRawShape>,
): ToolManifest['parameters'] {
  try {
    return zodObjectToJsonSchema(parameters);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw defineError(
      'INVALID_PARAMETERS',
      'parameters',
      `parameters could not be converted to JSON Schema: ${detail}`,
    );
  }
}

function validateVersion(version: unknown): string {
  if (typeof version !== 'string') {
    throw defineError('INVALID_VERSION', 'version', 'version must be a string');
  }
  if (!SEMVER_PATTERN.test(version)) {
    throw defineError(
      'INVALID_VERSION',
      'version',
      `version must be strict semver MAJOR.MINOR.PATCH (for example 1.0.0 or 1.0.0-beta.1), got "${version}"`,
    );
  }
  return version;
}

function validateDescription(description: unknown): string {
  if (typeof description !== 'string') {
    throw defineError('INVALID_DESCRIPTION', 'description', 'description must be a string');
  }
  const trimmed = description.trim();
  if (trimmed.length === 0) {
    throw defineError('INVALID_DESCRIPTION', 'description', 'description must not be empty');
  }
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw defineError(
      'INVALID_DESCRIPTION',
      'description',
      `description must be at most ${MAX_DESCRIPTION_LENGTH} characters, got ${trimmed.length}`,
    );
  }
  return trimmed;
}

function resolveCapabilities(input: Capabilities | undefined): ManifestCapabilities {
  if (input === undefined) {
    input = {};
  }
  if (!isRecord(input)) {
    throw capabilityError('capabilities', 'capabilities must be an object');
  }
  assertOnlyKeys(input, CAPABILITIES_KEYS, 'capabilities');

  const fs = input.fs === undefined ? {} : objectValue(input.fs, 'capabilities.fs');
  assertOnlyKeys(fs, FS_KEYS, 'capabilities.fs');

  const processCaps =
    input.process === undefined ? {} : objectValue(input.process, 'capabilities.process');
  assertOnlyKeys(processCaps, PROCESS_KEYS, 'capabilities.process');

  const net = input.net === undefined ? {} : objectValue(input.net, 'capabilities.net');
  assertOnlyKeys(net, NET_KEYS, 'capabilities.net');

  const env = input.env === undefined ? {} : objectValue(input.env, 'capabilities.env');
  assertOnlyKeys(env, ENV_KEYS, 'capabilities.env');

  const limits =
    input.limits === undefined ? {} : objectValue(input.limits, 'capabilities.limits');
  assertOnlyKeys(limits, LIMIT_KEYS, 'capabilities.limits');

  return {
    fs: {
      read: stringList(fs.read, 'capabilities.fs.read'),
      write: stringList(fs.write, 'capabilities.fs.write'),
    },
    process: {
      argv: stringList(processCaps.argv, 'capabilities.process.argv'),
    },
    net: {
      hosts: hostList(net.hosts),
    },
    env: {
      read: envNameList(env.read, 'capabilities.env.read'),
    },
    limits: {
      timeoutMs: positiveInteger(limits.timeoutMs, 'capabilities.limits.timeoutMs', DEFAULT_TIMEOUT_MS),
      maxOutputBytes: positiveInteger(
        limits.maxOutputBytes,
        'capabilities.limits.maxOutputBytes',
        DEFAULT_MAX_OUTPUT_BYTES,
      ),
    },
  };
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw capabilityError(field, `${field} must be an array of strings`);
  }
  const items = value.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw capabilityError(field, `${field}[${index}] must be a non-empty string`);
    }
    if (item.includes('\0')) {
      throw capabilityError(field, `${field}[${index}] must not contain NUL bytes`);
    }
    return item.trim();
  });
  return [...new Set(items)].sort();
}

/**
 * `net.hosts` entries are bare host names.
 *
 * A model that has just pasted a URL writes `https://api.exa.ai` or
 * `api.exa.ai/search`, and the runtime then compares a host against a string it
 * can never equal: the tool is denied in its smoke test and the reason reads
 * like a policy decision. Refusing the shape here names what is wrong while the
 * author can still fix it. `*` and `*.example.com` stay valid.
 */
function hostList(value: unknown): string[] {
  const hosts = stringList(value, 'capabilities.net.hosts');
  for (const host of hosts) {
    if (host === '*') continue;
    if (/^https?:\/\//i.test(host) || host.includes('/') || host.includes(':')) {
      throw capabilityError(
        'capabilities.net.hosts',
        `capabilities.net.hosts entry ${JSON.stringify(host)} must be a bare host name such as api.example.com or *.example.com, never a URL, a path or a port`,
      );
    }
  }
  return hosts;
}

/**
 * `env.read` names are exact identifiers: no globs, no `'*'`, no duplicates.
 *
 * This is the authoring half of the runtime's own check (`assertEnvNames` in
 * `policy.ts`): a definition that asks for every secret with one wildcard is
 * refused before it can become a manifest.
 */
function envNameList(value: unknown, field: string): string[] {
  const names = stringList(value, field);
  for (const name of names) {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw capabilityError(
        field,
        `${field} entry "${name}" must be an environment variable name matching ${ENV_NAME_PATTERN.source}`,
      );
    }
  }
  return names;
}

function positiveInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw capabilityError(
      field,
      `${field} must be a positive integer number of ${field.endsWith('Ms') ? 'milliseconds' : 'bytes'}, got ${String(value)}`,
    );
  }
  return value;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw capabilityError(`${field}.${key}`, `unknown capability "${field}.${key}"`);
    }
  }
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw capabilityError(field, `${field} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defineError(
  code: ToolDefinitionErrorCode,
  field: string,
  message: string,
): ToolDefinitionError {
  return new ToolDefinitionError(code, field, message);
}

function capabilityError(field: string, message: string): ToolDefinitionError {
  return defineError('INVALID_CAPABILITIES', field, message);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
