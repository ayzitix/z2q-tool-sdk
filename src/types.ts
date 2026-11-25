import type { z } from 'zod';

/** A value that survives `JSON.stringify` / `JSON.parse` unchanged. */
export type Json = JsonPrimitive | JsonObject | JsonArray;
export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: Json };
export type JsonArray = Json[];

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * What a tool asks the runtime for. Nothing here grants anything: the host
 * broker reads the manifest and decides what to allow.
 */
export interface Capabilities {
  fs?: FsCapabilities;
  process?: ProcessCapabilities;
  net?: NetCapabilities;
  limits?: LimitCapabilities;
}

export interface FsCapabilities {
  /** Workspace-relative path patterns the tool may read. */
  read?: string[];
  /** Workspace-relative path patterns the tool may write. */
  write?: string[];
}

export interface ProcessCapabilities {
  /** Executables the tool may run. `argv[0]` only; never a shell string. */
  argv?: string[];
}

export interface NetCapabilities {
  /** Host allow-list, for example `["api.github.com"]`. */
  hosts?: string[];
}

export interface LimitCapabilities {
  /** Wall-clock budget per call. Default 30000. */
  timeoutMs?: number;
  /** Captured stdout/stderr budget per call. Default 1048576 (1 MiB). */
  maxOutputBytes?: number;
}

/** Capabilities after defaults, sorting and de-duplication. */
export interface ManifestCapabilities {
  fs: { read: string[]; write: string[] };
  process: { argv: string[] };
  net: { hosts: string[] };
  limits: { timeoutMs: number; maxOutputBytes: number };
}

/** The plain-JSON description of a tool. This is what `tool.json` contains. */
export interface ToolManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  description: string;
  parameters: JsonObject;
  capabilities: ManifestCapabilities;
}

export type ToolParameters = z.ZodObject<z.ZodRawShape>;

export interface DefineToolOptions<Shape extends z.ZodRawShape> {
  /** 3-64 chars, `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`; `tool.<slug>` recommended. */
  name: string;
  /** Strict semver, for example `1.2.3` or `1.2.3-beta.1`. */
  version: string;
  /** Non-empty, at most 500 characters. */
  description: string;
  /** Tool arguments. Converted to JSON Schema in the manifest. */
  parameters: z.ZodObject<Shape>;
  /** Declarative only. The runtime enforces it. */
  capabilities?: Capabilities;
  run(ctx: ToolContext, args: z.infer<z.ZodObject<Shape>>): Promise<Json>;
}

export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  /** Plain JSON, frozen, deterministic. Safe to write to `tool.json`. */
  readonly manifest: ToolManifest;
  /**
   * The zod schema, kept for runtime validation. Hosts should call
   * `runTool(tool, args, ctx)` rather than `tool.run` directly.
   */
  readonly parameters: z.ZodObject<Shape>;
  run(ctx: ToolContext, args: z.infer<z.ZodObject<Shape>>): Promise<Json>;
}

/** A tool definition of unknown generic shape, for runtime plumbing. */
export type AnyToolDefinition = ToolDefinition<z.ZodRawShape>;

export interface FsEntry {
  name: string;
  /** Workspace-relative path, `/`-separated. */
  path: string;
  kind: 'file' | 'directory';
}

export interface GrepMatch {
  path: string;
  /** 1-based line number. */
  line: number;
  text: string;
}

export interface GrepOptions {
  /** Limit the search to files matching this glob. Defaults to every file. */
  glob?: string;
  ignoreCase?: boolean;
}

export interface ProcessRunOptions {
  /** Executable plus arguments. Never a shell command string. */
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

export interface ProcessRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface NetFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface NetFetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Injected by the runtime (host broker or QuickJS bridge). The SDK never
 * constructs one for production use and never grants capabilities itself.
 */
export interface ToolContext {
  /** Absolute workspace root. */
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly fs: {
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    list(path: string): Promise<FsEntry[]>;
    glob(pattern: string): Promise<string[]>;
    grep(pattern: string, options?: GrepOptions): Promise<GrepMatch[]>;
  };
  readonly process: {
    run(options: ProcessRunOptions): Promise<ProcessRunResult>;
  };
  readonly net: {
    fetch(url: string, init?: NetFetchInit): Promise<NetFetchResult>;
  };
  log(level: LogLevel, message: string): void;
}
