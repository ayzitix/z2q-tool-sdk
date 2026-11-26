/**
 * Read a `.env` file for `ctx.env`.
 *
 * A tool that needs a key should not have to guess where it lives: the sandbox
 * cannot read outside the workspace, so a `~/.config/...` fallback is a policy
 * denial dressed up as a lookup, and exporting a variable before every run is a
 * step people forget. `<workspace>/.env` is the one place both the person and
 * the tool already agree on.
 *
 * The parser is deliberately small and forgiving:
 *
 * - `KEY=value`, `KEY = value`, `export KEY=value` (the shell habit people carry
 *   over), `#` comment lines, and blank lines.
 * - A value may be wrapped in single or double quotes; the quotes are removed
 *   and nothing inside them is interpreted. No `$VAR` expansion, no `\n`
 *   escapes: a key that contains a `\` is literal, which is what a random token
 *   looks like.
 * - A trailing `\r` is stripped (a file saved on Windows), and a line that does
 *   not look like an assignment is skipped rather than failing the whole file:
 *   one stray line must not cost the run its credentials.
 * - Duplicate names: the last one wins, as in every dotenv implementation.
 *
 * Nothing here logs a value, and nothing is exported into the host environment:
 * the map is a snapshot the broker resolves a *declared* name from.
 */

/** What a `.env` file gave us, plus what was skipped and why. */
export interface DotenvResult {
  values: Record<string, string>;
  /** 1-based line numbers that were not assignments, for a single warn line. */
  skipped: number[];
}

const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  // An unquoted value ends at the first ` #` (a comment after a value), which is
  // how people annotate a key they pasted.
  const comment = value.search(/\s#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

/** Parse `.env` text. Pure, so the tests need no file system. */
export function parseDotenv(text: string): DotenvResult {
  const values: Record<string, string> = {};
  const skipped: number[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = ASSIGNMENT.exec(trimmed);
    if (match === null) {
      skipped.push(index + 1);
      continue;
    }
    const name = match[1];
    if (name === undefined) {
      skipped.push(index + 1);
      continue;
    }
    values[name] = unquote(match[2] ?? '');
  }
  return { values, skipped };
}

/**
 * Read `file` and parse it, or return an empty result.
 *
 * A missing file is the normal case (most workspaces have none) and an
 * unreadable one is not worth failing a tool call over: the tool then sees
 * `ctx.env.NAME === undefined` and reports its own missing-key message, which is
 * the honest outcome. `readFile` is injected so this module stays free of
 * `node:fs` and is testable without touching disk.
 */
export function readDotenv(
  readFile: (path: string) => string,
): (path: string) => DotenvResult {
  return (path: string) => {
    try {
      return parseDotenv(readFile(path));
    } catch {
      return { values: {}, skipped: [] };
    }
  };
}
