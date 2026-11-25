import { ToolRuntimeError } from './errors.js';
import type { ToolRuntimeCode } from './errors.js';
import { runtimeHost } from './host.js';
import { SANDBOX_MAX_AUDIT_ROWS } from './limits.js';

/**
 * One decision the broker made. Rows are deliberately dull: a timestamp, the
 * tool, the host call, allow or deny, and a target that is never file contents
 * and never an absolute host path.
 */
export interface AuditRow {
  ts: number;
  tool: string;
  version: string;
  kind: string;
  decision: 'allow' | 'deny';
  code?: ToolRuntimeCode;
  /** Workspace-relative path, `argv[0]` basename, or the call kind. */
  target?: string;
  durationMs?: number;
}

/** Where audit rows go. Sinks may be async; a throwing sink never breaks a call. */
export interface AuditSink {
  write(rows: readonly AuditRow[]): void | Promise<void>;
}

/** A sink that keeps rows in memory, handy for tests and for the CLI. */
export function createMemoryAuditSink(): AuditSink & { rows: AuditRow[] } {
  const rows: AuditRow[] = [];
  return {
    rows,
    write(incoming) {
      rows.push(...incoming);
    },
  };
}

/** Append one JSON object per line. The file is created on the first flushed call. */
export function createJsonlAuditSink(file: string): AuditSink {
  return {
    async write(rows) {
      if (rows.length === 0) return;
      const host = await runtimeHost();
      const text = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
      host.fs.appendFileSync(file, text);
    },
  };
}

/** Accept the three shapes `ToolRuntimeOptions.audit` allows. */
export function toAuditSink(
  audit: AuditSink | AuditRow[] | null | undefined,
): AuditSink | undefined {
  if (audit === null || audit === undefined) return undefined;
  if (Array.isArray(audit)) {
    return {
      write(rows) {
        audit.push(...rows);
      },
    };
  }
  if (typeof audit.write !== 'function') {
    throw new ToolRuntimeError('invalid_arguments', 'audit must be a sink, an array or null');
  }
  return audit;
}

/**
 * Collects one call's rows, caps them at {@link SANDBOX_MAX_AUDIT_ROWS} and adds
 * a single `audit_limit` summary row when anything was dropped.
 */
export class AuditCollector {
  readonly #tool: string;
  readonly #version: string;
  readonly #now: () => number;
  readonly #rows: AuditRow[] = [];
  #dropped = 0;

  constructor(tool: string, version: string, now: () => number) {
    this.#tool = tool;
    this.#version = version;
    this.#now = now;
  }

  allow(kind: string, target?: string, durationMs?: number): void {
    this.record({ kind, decision: 'allow', target, durationMs });
  }

  deny(kind: string, code: ToolRuntimeCode, target?: string): void {
    this.record({ kind, decision: 'deny', code, target });
  }

  get dropped(): number {
    return this.#dropped;
  }

  /** The rows for this call, including the `audit_limit` summary row. */
  finish(): readonly AuditRow[] {
    if (this.#dropped > 0) {
      this.#rows.push({
        ts: this.#now(),
        tool: this.#tool,
        version: this.#version,
        kind: 'audit',
        decision: 'deny',
        code: 'audit_limit',
        target: 'audit',
      });
      this.#dropped = 0;
    }
    return [...this.#rows];
  }

  private record(row: Omit<AuditRow, 'ts' | 'tool' | 'version'>): void {
    if (this.#rows.length >= SANDBOX_MAX_AUDIT_ROWS) {
      this.#dropped += 1;
      return;
    }
    const entry: AuditRow = {
      ts: this.#now(),
      tool: this.#tool,
      version: this.#version,
      kind: row.kind,
      decision: row.decision,
    };
    if (row.code !== undefined) entry.code = row.code;
    if (row.target !== undefined) entry.target = row.target;
    if (row.durationMs !== undefined) entry.durationMs = row.durationMs;
    this.#rows.push(entry);
  }
}
