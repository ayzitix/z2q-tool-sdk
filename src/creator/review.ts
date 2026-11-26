import { buildTool } from '../build.js';
import type { BuildToolResult } from '../build.js';
import type { ManifestCapabilities, ToolManifest } from '../types.js';
import { ToolCreatorError } from './prompt.js';

/** One refusal from the source reviewer. `code` is stable; `line` is 1-based. */
export interface ToolSourceIssue {
  code: string;
  message: string;
  line?: number;
}

/** The result of reviewing generated source. A report with `ok: false` never builds. */
export interface ToolSourceReport {
  ok: boolean;
  issues: ToolSourceIssue[];
  name?: string;
  version?: string;
  description?: string;
  capabilities?: ManifestCapabilities;
}

/**
 * The creator's hard limits. They are enforced twice: statically here, and
 * again on the manifest `buildTool` produced, so a computed value cannot slip
 * past the static reader.
 */
export const CREATOR_LIMITS = {
  sourceBytes: 32 * 1024,
  timeoutMs: 60_000,
  maxOutputBytes: 8_388_608,
  minDescriptionLength: 20,
} as const;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const MAX_TEMPLATE_DEPTH = 64;
const MAX_CAPABILITY_DEPTH = 32;
const MAX_REPORTED_MESSAGE = 500;

const ALLOWED_MODULES = new Set(['z1-tool-sdk', 'zod']);

/** The same shape `defineTool` and the runtime enforce on `env.read`. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Identifiers a generated tool may never contain. Strings and comments are not
 * identifiers, so `'process'` and `// eval` are allowed. The list is closed:
 * adding to it is a review decision, not an implementation detail.
 */
const FORBIDDEN_IDENTIFIERS = new Set([
  'process',
  'require',
  'eval',
  'Function',
  'globalThis',
  'Deno',
  'Bun',
  'child_process',
  'worker_threads',
  'net',
  'http',
  'https',
  'dns',
  'tls',
  'dgram',
  'os',
  'v8',
  'Atomics',
  'SharedArrayBuffer',
  'WebAssembly',
]);

/** Punctuation after which a `/` starts a regex literal rather than division. */
const REGEX_AFTER_PUNCT = new Set([
  '(',
  '[',
  '{',
  ',',
  ':',
  ';',
  '=',
  '!',
  '&',
  '|',
  '?',
  '*',
  '%',
  '^',
  '~',
  '<',
  '>',
  '/',
]);

/** Keywords after which a `/` starts a regex literal. */
const REGEX_AFTER_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/** Keywords whose parenthesised header makes a following `/` a statement. */
const CONTROL_KEYWORDS = new Set(['if', 'while', 'for', 'switch', 'catch', 'with']);

/**
 * Review generated source without executing it.
 *
 * This is an advisory lint, not a security boundary. Every rule that applies
 * produces at most one issue, and any issue means the caller must not build the
 * source. It never touches the filesystem and never executes the source. A
 * report that passes fills what the source declares literally;
 * `verifyToolSource` confirms it against the manifest read inside QuickJS.
 */
export function reviewToolSource(source: string): ToolSourceReport {
  if (typeof source !== 'string') {
    return failure('source_too_large', 'source must be a string');
  }
  if (source.length === 0) {
    return failure('source_too_large', 'source is empty');
  }
  const bytes = utf8Length(source);
  if (bytes > CREATOR_LIMITS.sourceBytes) {
    return failure(
      'source_too_large',
      `source is ${bytes} bytes, over the ${CREATOR_LIMITS.sourceBytes} byte limit`,
    );
  }

  const lexed = tokenize(source);
  if (!lexed.ok) {
    return {
      ok: false,
      issues: [
        {
          code: 'scan_failed',
          message: `the source could not be scanned: ${lexed.failure.reason}; review refuses rather than guessing`,
          line: lexed.failure.line,
        },
      ],
    };
  }
  const tokens = lexed.tokens;
  const issues: ToolSourceIssue[] = [];

  const definition = findDefinitionOpenParen(tokens);
  if (definition === undefined) {
    issues.push({
      code: 'missing_definition',
      message: 'expected an ESM module with `export const tool = defineTool({ ... })`',
    });
  }

  const importIssue = checkImports(tokens);
  if (importIssue !== undefined) issues.push(importIssue);

  const identifierIssue = firstForbiddenIdentifier(tokens);
  if (identifierIssue !== undefined) issues.push(identifierIssue);

  let name: string | undefined;
  let version: string | undefined;
  let description: string | undefined;
  let capabilities: ManifestCapabilities | undefined;

  if (definition !== undefined) {
    const optionsIndex = definition + 1;
    if (!isPunct(tokens[optionsIndex], '{')) {
      issues.push({
        code: 'missing_capabilities',
        message:
          'the defineTool argument must be an object literal so the review can read capabilities',
      });
    } else {
      const nameToken = readStringProperty(tokens, optionsIndex, 'name');
      if (nameToken !== undefined) name = nameToken.value;
      const versionToken = readStringProperty(tokens, optionsIndex, 'version');
      if (versionToken !== undefined) version = versionToken.value;

      const capabilitiesIndex = findLastTopLevelProperty(tokens, optionsIndex, 'capabilities');
      if (capabilitiesIndex === undefined) {
        issues.push({
          code: 'missing_capabilities',
          message: 'defineTool requires a capabilities declaration, even when it is empty',
        });
      } else {
        const parsed = parseCapabilityValue(tokens, capabilitiesIndex, 0);
        if (parsed === undefined || parsed.value.kind !== 'object') {
          issues.push({
            code: 'missing_capabilities',
            message:
              'capabilities must be a literal object so the review can read every grant before the build',
          });
        } else {
          capabilities = checkCapabilities(parsed.value, issues);
        }
      }

      const descriptionIndex = findLastTopLevelProperty(tokens, optionsIndex, 'description');
      const descriptionToken = descriptionIndex === undefined ? undefined : tokens[descriptionIndex];
      if (descriptionToken === undefined || descriptionToken.kind !== 'string') {
        issues.push({
          code: 'weak_description',
          message: 'description must be a literal string of at least 20 characters',
          ...(descriptionToken === undefined ? {} : { line: descriptionToken.line }),
        });
      } else {
        description = descriptionToken.value.trim();
        if (description.length < CREATOR_LIMITS.minDescriptionLength) {
          issues.push({
            code: 'weak_description',
            message: `description is ${description.length} characters; it must be at least ${CREATOR_LIMITS.minDescriptionLength}`,
            line: descriptionToken.line,
          });
        }
      }
    }
  }

  // Rule 6 (second half): a call the manifest does not declare is refused here,
  // after every other rule, so a source that breaks an older rule still reports
  // that rule first.
  if (capabilities !== undefined) {
    const undeclared = findUndeclaredCapability(tokens, capabilities);
    if (undeclared !== undefined) issues.push(undeclared);
  }

  const report: ToolSourceReport = { ok: issues.length === 0, issues };
  if (name !== undefined) report.name = name;
  if (version !== undefined) report.version = version;
  if (description !== undefined) report.description = description;
  if (capabilities !== undefined) report.capabilities = capabilities;
  return report;
}

/**
 * Review statically, then build the source in a temp directory (never the
 * caller's) and confirm the manifest. The build reads the bundle in QuickJS,
 * where its top level runs, so it only happens after every static rule passed
 * and it never reaches the host. A build failure is one `build_failed` issue
 * and never a stack.
 */
export async function verifyToolSource(source: string): Promise<ToolSourceReport> {
  const report = reviewToolSource(source);
  if (!report.ok) return report;

  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'z1-review-'));
  try {
    await fs.writeFile(path.join(dir, 'tool.ts'), source, 'utf8');
    const built = await buildToolProject(dir);
    return assessToolManifest(built.manifest);
  } catch (error) {
    return {
      ok: false,
      issues: [buildFailedIssue(error)],
      ...(report.name === undefined ? {} : { name: report.name }),
      ...(report.version === undefined ? {} : { version: report.version }),
      ...(report.description === undefined ? {} : { description: report.description }),
      ...(report.capabilities === undefined ? {} : { capabilities: report.capabilities }),
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Check the resolved manifest with the same rules. Used after a build and by
 * `installTool`, so the final artefact is checked even though the static reader
 * already reviewed the declarations.
 */
export function assessToolManifest(manifest: ToolManifest): ToolSourceReport {
  const issues: ToolSourceIssue[] = [];
  const capabilities = manifest.capabilities;

  const argvGrant = capabilities.process.argv.find((grant) => !isBareExecutableName(grant));
  if (argvGrant !== undefined) {
    issues.push({
      code: 'invalid_argv_grant',
      message: `process.argv grant "${argvGrant}" is not a bare executable name`,
    });
  }
  const fsGrant = [...capabilities.fs.read, ...capabilities.fs.write].find(
    (grant) => !isWorkspaceRelativeGrant(grant),
  );
  if (fsGrant !== undefined) {
    issues.push({
      code: 'invalid_fs_grant',
      message: `fs grant "${fsGrant}" is not a workspace-relative path or glob`,
    });
  }
  if (
    capabilities.limits.timeoutMs > CREATOR_LIMITS.timeoutMs ||
    capabilities.limits.maxOutputBytes > CREATOR_LIMITS.maxOutputBytes
  ) {
    issues.push({
      code: 'limit_too_large',
      message: `limits exceed the runtime ceiling (timeoutMs <= ${CREATOR_LIMITS.timeoutMs}, maxOutputBytes <= ${CREATOR_LIMITS.maxOutputBytes})`,
    });
  }
  if (manifest.description.trim().length < CREATOR_LIMITS.minDescriptionLength) {
    issues.push({
      code: 'weak_description',
      message: `description is shorter than ${CREATOR_LIMITS.minDescriptionLength} characters`,
    });
  }

  return {
    ok: issues.length === 0,
    issues,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    capabilities,
  };
}

/**
 * Build a tool project in place, with one fallback: when the project has not
 * installed `z1-tool-sdk` or `zod` (a fresh creator project), the host's own
 * copies are supplied to esbuild as aliases. Callers should review the source
 * first; the build itself reads the bundle inside QuickJS and never imports it
 * on the host.
 */
export async function buildToolProject(dir: string): Promise<BuildToolResult> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const root = path.resolve(dir);
  const entry = path.join(root, 'tool.ts');
  const info = await fs.stat(entry).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    throw new ToolCreatorError('missing_entry', `missing tool.ts in ${root}`);
  }
  const aliases = await fallbackAliases(root);
  return buildTool({ entry, cwd: root, ...(aliases === undefined ? {} : { aliases }) });
}

/** `code (line N): message` for an error or a CLI line. */
export function formatSourceIssues(issues: readonly ToolSourceIssue[]): string {
  return issues
    .map(
      (issue) =>
        `${issue.code}${issue.line === undefined ? '' : ` (line ${issue.line})`}: ${issue.message}`,
    )
    .join('; ');
}

function failure(code: string, message: string): ToolSourceReport {
  return { ok: false, issues: [{ code, message }] };
}

// ---------------------------------------------------------------------------
// Lexer
//
// The reviewer must not be fooled by text: rule 4 is about identifiers, so
// strings and comments are skipped, template interpolations are tokenized (they
// are code), and identifier escapes are decoded. A regex literal is deliberately
// *not* skipped: its body is not a string or a comment, and treating it as code
// can only produce a false refusal, never a missed identifier.
// ---------------------------------------------------------------------------

type TokenKind = 'ident' | 'punct' | 'string' | 'number' | 'template' | 'regex';

interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  /** Set on `)` when the matching `(` is an if/while/for/switch/catch/with header. */
  parenControl?: boolean;
}

interface LexFailure {
  reason: string;
  line: number;
}

type LexResult = { ok: true; tokens: Token[] } | { ok: false; failure: LexFailure };

function tokenize(source: string): LexResult {
  const tokens: Token[] = [];
  const length = source.length;
  let index = 0;
  let line = 1;
  let failure: LexFailure | undefined;

  const at = (offset = 0): string | undefined => source[index + offset];

  const advance = (): string => {
    const char = source[index] ?? '';
    index += 1;
    if (char === '\n') line += 1;
    return char;
  };

  const fail = (reason: string, atLine = line): false => {
    if (failure === undefined) failure = { reason, line: atLine };
    index = length;
    return false;
  };

  const isIdentStart = (char: string): boolean => /[A-Za-z_$]/.test(char);
  const isIdentPart = (char: string): boolean => /[A-Za-z0-9_$]/.test(char);

  // Reads the body of a `\u` escape; `index` is at the `u`.
  const readUnicodeEscape = (): string | undefined => {
    advance();
    if (at() === '{') {
      advance();
      let hex = '';
      while (index < length && at() !== '}') hex += advance();
      if (at() !== '}') return undefined;
      advance();
      if (!/^[0-9a-fA-F]+$/.test(hex)) return undefined;
      const code = Number.parseInt(hex, 16);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return undefined;
      return String.fromCodePoint(code);
    }
    let hex = '';
    for (let count = 0; count < 4; count += 1) {
      const char = at();
      if (char === undefined) return undefined;
      hex += advance();
    }
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
    return String.fromCharCode(Number.parseInt(hex, 16));
  };

  // Reads one escape; `index` is at the backslash.
  const readStringEscape = (): string | undefined => {
    advance();
    const char = at();
    if (char === undefined) return undefined;
    switch (char) {
      case 'n':
        advance();
        return '\n';
      case 'r':
        advance();
        return '\r';
      case 't':
        advance();
        return '\t';
      case 'b':
        advance();
        return '\b';
      case 'f':
        advance();
        return '\f';
      case 'v':
        advance();
        return '\v';
      case '0':
        advance();
        return '\0';
      case '\n':
        advance();
        return '';
      case '\r':
        advance();
        if (at() === '\n') advance();
        return '';
      case 'x': {
        advance();
        let hex = '';
        for (let count = 0; count < 2; count += 1) {
          const digit = at();
          if (digit === undefined) return undefined;
          hex += advance();
        }
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return undefined;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      case 'u':
        return readUnicodeEscape();
      default:
        return advance();
    }
  };

  const scanString = (quote: string): boolean => {
    const startLine = line;
    advance();
    let value = '';
    while (index < length) {
      const char = at();
      if (char === quote) {
        advance();
        tokens.push({ kind: 'string', value, line: startLine });
        return true;
      }
      if (char === '\\') {
        const decoded = readStringEscape();
        if (decoded === undefined) return fail('invalid escape in a string literal', startLine);
        value += decoded;
        continue;
      }
      if (char === '\n' || char === '\r') return fail('unterminated string literal', startLine);
      value += advance();
    }
    return fail('unterminated string literal', startLine);
  };

  const scanIdentifier = (): boolean => {
    const startLine = line;
    let value = '';
    while (index < length) {
      const char = at();
      if (char !== undefined && isIdentPart(char)) {
        value += advance();
        continue;
      }
      if (char === '\\' && at(1) === 'u') {
        advance();
        const decoded = readUnicodeEscape();
        if (decoded === undefined) return fail('invalid identifier escape', startLine);
        if (value.length === 0 && !isIdentStart(decoded)) {
          return fail('invalid identifier escape', startLine);
        }
        value += decoded;
        continue;
      }
      break;
    }
    tokens.push({ kind: 'ident', value, line: startLine });
    return true;
  };

  const scanNumber = (): void => {
    const startLine = line;
    let value = '';
    while (index < length) {
      const char = at();
      if (char !== undefined && /[0-9a-zA-Z_.]/.test(char)) {
        value += advance();
        continue;
      }
      if ((char === '+' || char === '-') && /[eE]$/.test(value)) {
        value += advance();
        continue;
      }
      break;
    }
    tokens.push({ kind: 'number', value, line: startLine });
  };

  const scanTemplate = (depth: number): boolean => {
    const startLine = line;
    if (depth > MAX_TEMPLATE_DEPTH) return fail('template literals are nested too deeply', startLine);
    advance();
    tokens.push({ kind: 'template', value: '', line: startLine });
    while (index < length) {
      const char = at();
      if (char === '\\') {
        advance();
        if (index < length) advance();
        continue;
      }
      if (char === '`') {
        advance();
        return true;
      }
      if (char === '$' && at(1) === '{') {
        advance();
        advance();
        if (!scanCode(true, depth + 1)) return false;
        continue;
      }
      advance();
    }
    return fail('unterminated template literal', startLine);
  };

  /**
   * Decide whether the `/` at `index` starts a regex. `true` means regex,
   * `false` means division, and `undefined` means the scanner refuses to guess:
   * guessing wrong in either direction is a bypass, so an ambiguous slash is a
   * scan failure.
   */
  const regexAhead = (expressionStart: boolean): boolean | undefined => {
    if (expressionStart) return true;
    const previous = tokens[tokens.length - 1];
    if (previous === undefined) return true;
    if (previous.kind === 'punct') {
      if (previous.value === ')') {
        return previous.parenControl === true ? undefined : false;
      }
      if (previous.value === '}' || previous.value === '+' || previous.value === '-') {
        return undefined;
      }
      if (previous.value === ']' || previous.value === '.') return false;
      return REGEX_AFTER_PUNCT.has(previous.value) ? true : undefined;
    }
    if (previous.kind === 'ident') {
      // `obj.return / 2` is a property access and division, not `return`.
      if (isPunct(tokens[tokens.length - 2], '.')) return false;
      // `of` is contextual: `for (x of /re/)` is a regex, `of / 2` with a
      // variable named `of` is division. Refuse rather than guess.
      if (previous.value === 'of') return undefined;
      if (!REGEX_AFTER_KEYWORDS.has(previous.value)) return false;
      return true;
    }
    return false;
  };

  const scanRegex = (): boolean => {
    const startLine = line;
    advance();
    let inClass = false;
    let closed = false;
    while (index < length) {
      const char = at();
      if (char === '\\') {
        advance();
        if (index < length) advance();
        continue;
      }
      if (char === '\n' || char === '\r') {
        return fail('unterminated regular expression literal', startLine);
      }
      if (char === '[') {
        inClass = true;
        advance();
        continue;
      }
      if (char === ']') {
        inClass = false;
        advance();
        continue;
      }
      if (char === '/' && !inClass) {
        advance();
        closed = true;
        break;
      }
      advance();
    }
    if (!closed) return fail('unterminated regular expression literal', startLine);
    while (index < length) {
      const char = at();
      if (char === undefined || !/[a-z]/i.test(char)) break;
      advance();
    }
    tokens.push({ kind: 'regex', value: '', line: startLine });
    return true;
  };

  const scanCode = (stopAtTemplateBrace: boolean, depth: number): boolean => {
    const startIndex = tokens.length;
    let braces = 0;
    const parens: boolean[] = [];
    while (index < length) {
      const char = at();
      if (char === undefined) break;
      if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
        advance();
        continue;
      }
      if (char === '/' && at(1) === '/') {
        advance();
        advance();
        while (index < length && at() !== '\n') advance();
        continue;
      }
      if (char === '/' && at(1) === '*') {
        const startLine = line;
        advance();
        advance();
        let closed = false;
        while (index < length) {
          if (at() === '*' && at(1) === '/') {
            advance();
            advance();
            closed = true;
            break;
          }
          advance();
        }
        if (!closed) return fail('unterminated block comment', startLine);
        continue;
      }
      if (char === '/') {
        const regex = regexAhead(tokens.length === startIndex);
        if (regex === undefined) {
          return fail(
            'the static review cannot tell a regular expression from division here',
            line,
          );
        }
        if (regex) {
          if (!scanRegex()) return false;
          continue;
        }
        tokens.push({ kind: 'punct', value: '/', line });
        advance();
        continue;
      }
      if (stopAtTemplateBrace && char === '}' && braces === 0) {
        advance();
        return true;
      }
      if (char === '(') {
        const control = isControlParen(tokens);
        tokens.push({ kind: 'punct', value: '(', line });
        parens.push(control);
        advance();
        continue;
      }
      if (char === ')') {
        const control = parens.pop() ?? false;
        tokens.push({ kind: 'punct', value: ')', line, parenControl: control });
        advance();
        continue;
      }
      if (char === '{') {
        braces += 1;
        tokens.push({ kind: 'punct', value: '{', line });
        advance();
        continue;
      }
      if (char === '}') {
        if (braces > 0) braces -= 1;
        tokens.push({ kind: 'punct', value: '}', line });
        advance();
        continue;
      }
      if (char === '`') {
        if (!scanTemplate(depth + 1)) return false;
        continue;
      }
      if (char === '"' || char === "'") {
        if (!scanString(char)) return false;
        continue;
      }
      if (isIdentStart(char) || (char === '\\' && at(1) === 'u')) {
        if (!scanIdentifier()) return false;
        continue;
      }
      if (/[0-9]/.test(char)) {
        scanNumber();
        continue;
      }
      const startLine = line;
      tokens.push({ kind: 'punct', value: advance(), line: startLine });
    }
    if (stopAtTemplateBrace) return fail('unterminated template expression');
    return true;
  };

  if (!scanCode(false, 0)) {
    return { ok: false, failure: failure ?? { reason: 'the source could not be scanned', line } };
  }
  return { ok: true, tokens };
}

// ---------------------------------------------------------------------------
// Token navigation
// ---------------------------------------------------------------------------

function isPunct(token: Token | undefined, value: string): boolean {
  return token !== undefined && token.kind === 'punct' && token.value === value;
}

function isIdent(token: Token | undefined, value: string): boolean {
  return token !== undefined && token.kind === 'ident' && token.value === value;
}

/** True when the `(` about to be pushed belongs to a control-flow header. */
function isControlParen(tokens: readonly Token[]): boolean {
  const previous = tokens[tokens.length - 1];
  if (previous === undefined || previous.kind !== 'ident') return false;
  if (isPunct(tokens[tokens.length - 2], '.')) return false;
  if (CONTROL_KEYWORDS.has(previous.value)) return true;
  return previous.value === 'await' && isIdent(tokens[tokens.length - 2], 'for');
}

const TYPE_OPEN = new Set(['{', '[', '(', '<']);
const TYPE_CLOSE = new Set(['}', ']', ')', '>']);
const VALUE_OPEN = new Set(['{', '[', '(']);
const VALUE_CLOSE = new Set(['}', ']', ')']);

/** Index of the `(` in `export const tool[: Type] = defineTool(`, if present. */
function findDefinitionOpenParen(tokens: readonly Token[]): number | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isIdent(tokens[index], 'export')) continue;
    if (!isIdent(tokens[index + 1], 'const')) continue;
    if (!isIdent(tokens[index + 2], 'tool')) continue;

    let cursor = index + 3;
    if (isPunct(tokens[cursor], ':')) {
      cursor += 1;
      let depth = 0;
      let equals = -1;
      while (cursor < tokens.length) {
        const token = tokens[cursor];
        if (token !== undefined && token.kind === 'punct') {
          if (token.value === '=' && isPunct(tokens[cursor + 1], '>')) {
            cursor += 1;
            continue;
          }
          if (TYPE_OPEN.has(token.value)) {
            depth += 1;
            cursor += 1;
            continue;
          }
          if (TYPE_CLOSE.has(token.value)) {
            depth = Math.max(0, depth - 1);
            cursor += 1;
            continue;
          }
          if (token.value === '=' && depth === 0) {
            equals = cursor;
            break;
          }
          if (token.value === ';' && depth === 0) break;
        }
        cursor += 1;
      }
      if (equals < 0) continue;
      cursor = equals;
    }

    if (!isPunct(tokens[cursor], '=')) continue;
    if (!isIdent(tokens[cursor + 1], 'defineTool')) continue;
    if (!isPunct(tokens[cursor + 2], '(')) continue;
    return cursor + 2;
  }
  return undefined;
}

/**
 * Index of the value of the last top-level `name:` property in the object at
 * `openBrace`. Last wins, matching JavaScript, so a duplicate `capabilities`
 * key cannot hide a stricter declaration behind a harmless one.
 */
function findLastTopLevelProperty(
  tokens: readonly Token[],
  openBrace: number,
  name: string,
): number | undefined {
  let depth = 0;
  let found: number | undefined;
  for (let index = openBrace + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) break;
    if (token.kind === 'punct') {
      if (VALUE_OPEN.has(token.value)) {
        depth += 1;
        continue;
      }
      if (VALUE_CLOSE.has(token.value)) {
        if (token.value === '}' && depth === 0) return found;
        depth = Math.max(0, depth - 1);
        continue;
      }
    }
    if (depth !== 0) continue;
    // A key starts a property only after `{` or `,`. This keeps a ternary such
    // as `note: cond ? 'capabilities' : {}` from being read as the key.
    if (!isPunct(tokens[index - 1], '{') && !isPunct(tokens[index - 1], ',')) continue;
    if (
      (token.kind === 'ident' || token.kind === 'string') &&
      token.value === name &&
      isPunct(tokens[index + 1], ':')
    ) {
      found = index + 2;
    }
  }
  return found;
}

function readStringProperty(
  tokens: readonly Token[],
  openBrace: number,
  name: string,
): { value: string; line: number } | undefined {
  const index = findLastTopLevelProperty(tokens, openBrace, name);
  if (index === undefined) return undefined;
  const token = tokens[index];
  if (token === undefined || token.kind !== 'string') return undefined;
  return { value: token.value, line: token.line };
}

// ---------------------------------------------------------------------------
// Rules 3 and 4
// ---------------------------------------------------------------------------

function checkImports(tokens: readonly Token[]): ToolSourceIssue | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.kind !== 'ident') continue;
    // `box.import('node:fs')` is a method call, not the import operator.
    if (isPunct(tokens[index - 1], '.')) continue;

    if (token.value === 'import') {
      const next = tokens[index + 1];
      if (isPunct(next, '.')) {
        return {
          code: 'forbidden_import',
          message: 'import.meta is not allowed; the tool has no host metadata to read',
          line: token.line,
        };
      }
      if (isPunct(next, '(')) {
        const argument = tokens[index + 2];
        if (argument === undefined || argument.kind !== 'string' || !isPunct(tokens[index + 3], ')')) {
          return {
            code: 'forbidden_import',
            message: 'dynamic import() must use a literal module name',
            line: token.line,
          };
        }
        if (!ALLOWED_MODULES.has(argument.value)) {
          return {
            code: 'forbidden_import',
            message: `dynamic import of "${argument.value}" is not allowed; only 'z1-tool-sdk' and 'zod'`,
            line: argument.line,
          };
        }
        continue;
      }
      if (next !== undefined && next.kind === 'string' && !ALLOWED_MODULES.has(next.value)) {
        return {
          code: 'forbidden_import',
          message: `import "${next.value}" is not allowed; only 'z1-tool-sdk' and 'zod'`,
          line: next.line,
        };
      }
    }

    if (token.value === 'from') {
      const specifier = tokens[index + 1];
      if (specifier !== undefined && specifier.kind === 'string' && !ALLOWED_MODULES.has(specifier.value)) {
        return {
          code: 'forbidden_import',
          message: `import "${specifier.value}" is not allowed; only 'z1-tool-sdk' and 'zod'`,
          line: specifier.line,
        };
      }
    }
  }
  return undefined;
}

function firstForbiddenIdentifier(tokens: readonly Token[]): ToolSourceIssue | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.kind !== 'ident') continue;
    if (!FORBIDDEN_IDENTIFIERS.has(token.value)) continue;
    if (isPropertyName(tokens, index)) continue;
    return {
      code: 'forbidden_identifier',
      message: `"${token.value}" is not allowed; a tool must use ctx for every host capability`,
      line: token.line,
    };
  }
  return undefined;
}

/**
 * A property name is not a reference: `ctx.process.run`, `args.net` and the
 * `process: { argv: [...] }` capability key are names, not the host globals.
 * Rule 4 bans identifiers, so it must not ban names - otherwise rule 7 could
 * never be reached and `ctx.process.run`, which the prompt teaches, would be
 * refused. A spread (`...process`) is still a reference and stays banned.
 */
function isPropertyName(tokens: readonly Token[], index: number): boolean {
  if (isPunct(tokens[index - 1], '.')) {
    const spread = isPunct(tokens[index - 2], '.') && isPunct(tokens[index - 3], '.');
    return !spread;
  }
  if (isClassFieldName(tokens, index)) return true;
  if (isObjectPatternShorthand(tokens, index)) return true;
  if (!isPunct(tokens[index + 1], ':')) return false;
  return isPunct(tokens[index - 1], '{') || isPunct(tokens[index - 1], ',');
}

/**
 * A class field name is a declaration, not a reference. Only the name position
 * is skipped: `class C { os = 1 }` is harmless, while the `process` in
 * `class C { os = process }` is still a reference and stays refused.
 */
function isClassFieldName(tokens: readonly Token[], index: number): boolean {
  const next = tokens[index + 1];
  const afterName =
    isPunct(next, '=') ||
    isPunct(next, ';') ||
    isPunct(next, '}') ||
    isPunct(next, ':') ||
    isPunct(next, '?') ||
    isPunct(next, '!');
  if (!afterName) return false;
  const previous = tokens[index - 1];
  const beforeName =
    isPunct(previous, '{') ||
    isPunct(previous, ';') ||
    isPunct(previous, '}') ||
    isPunct(previous, '#') ||
    isIdent(previous, 'static');
  if (!beforeName) return false;

  const open = enclosingBrace(tokens, index);
  if (open === undefined) return false;
  // The enclosing brace must be the class body itself, not a static block or a
  // method body nested inside one.
  for (let cursor = open - 1; cursor >= 0; cursor -= 1) {
    const token = tokens[cursor];
    if (token === undefined) return false;
    if (isIdent(token, 'class')) return true;
    if (
      token.kind === 'punct' &&
      (token.value === '{' || token.value === ';' || token.value === '}')
    ) {
      return false;
    }
    if (isPunct(token, '=>')) return false;
  }
  return false;
}

/** `const { net } = value` binds a name; it does not read the host global. */
function isObjectPatternShorthand(tokens: readonly Token[], index: number): boolean {
  if (!isPunct(tokens[index + 1], ',') && !isPunct(tokens[index + 1], '}')) return false;
  const open = enclosingBrace(tokens, index);
  if (open === undefined) return false;
  const before = tokens[open - 1];
  return isIdent(before, 'const') || isIdent(before, 'let') || isIdent(before, 'var');
}

/** Index of the nearest `{` that has not been closed before `index`. */
function enclosingBrace(tokens: readonly Token[], index: number): number | undefined {
  let depth = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const token = tokens[cursor];
    if (token === undefined || token.kind !== 'punct') continue;
    if (token.value === '}') {
      depth += 1;
    } else if (token.value === '{') {
      if (depth === 0) return cursor;
      depth -= 1;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Rules 5-9: a literal reader for the capabilities object
//
// The reader understands only object/array/string/number/boolean/null/undefined
// literals. Anything else (a call, a spread, a variable, a template) makes the
// declaration unreadable and the review refuses it: the point is to decide
// before the module is imported, not to evaluate it.
// ---------------------------------------------------------------------------

type CapabilityValue =
  | { kind: 'object'; entries: Map<string, CapabilityValue>; line: number }
  | { kind: 'array'; items: CapabilityValue[]; line: number }
  | { kind: 'string'; value: string; line: number }
  | { kind: 'number'; value: number; line: number }
  | { kind: 'boolean'; value: boolean; line: number }
  | { kind: 'null'; line: number }
  | { kind: 'undefined'; line: number };

function parseCapabilityValue(
  tokens: readonly Token[],
  index: number,
  depth: number,
): { value: CapabilityValue; next: number } | undefined {
  if (depth > MAX_CAPABILITY_DEPTH) return undefined;
  const token = tokens[index];
  if (token === undefined) return undefined;

  if (token.kind === 'string') {
    return { value: { kind: 'string', value: token.value, line: token.line }, next: index + 1 };
  }
  if (token.kind === 'number') {
    const value = Number(token.value.replace(/_/g, ''));
    if (!Number.isFinite(value)) return undefined;
    return { value: { kind: 'number', value, line: token.line }, next: index + 1 };
  }
  if (token.kind === 'ident') {
    if (token.value === 'true' || token.value === 'false') {
      return {
        value: { kind: 'boolean', value: token.value === 'true', line: token.line },
        next: index + 1,
      };
    }
    if (token.value === 'null') {
      return { value: { kind: 'null', line: token.line }, next: index + 1 };
    }
    if (token.value === 'undefined') {
      return { value: { kind: 'undefined', line: token.line }, next: index + 1 };
    }
    return undefined;
  }
  if (isPunct(token, '{')) return parseCapabilityObject(tokens, index, depth);
  if (isPunct(token, '[')) return parseCapabilityArray(tokens, index, depth);
  return undefined;
}

function parseCapabilityObject(
  tokens: readonly Token[],
  openBrace: number,
  depth: number,
): { value: CapabilityValue; next: number } | undefined {
  const entries = new Map<string, CapabilityValue>();
  let index = openBrace + 1;
  while (true) {
    const token = tokens[index];
    if (token === undefined) return undefined;
    if (isPunct(token, '}')) {
      return { value: { kind: 'object', entries, line: token.line }, next: index + 1 };
    }
    if (token.kind !== 'ident' && token.kind !== 'string') return undefined;
    if (!isPunct(tokens[index + 1], ':')) return undefined;
    const parsed = parseCapabilityValue(tokens, index + 2, depth + 1);
    if (parsed === undefined) return undefined;
    entries.set(token.value, parsed.value);
    index = parsed.next;
    if (isPunct(tokens[index], ',')) {
      index += 1;
      continue;
    }
    if (isPunct(tokens[index], '}')) {
      const close = tokens[index] as Token;
      return { value: { kind: 'object', entries, line: close.line }, next: index + 1 };
    }
    return undefined;
  }
}

function parseCapabilityArray(
  tokens: readonly Token[],
  openBracket: number,
  depth: number,
): { value: CapabilityValue; next: number } | undefined {
  const items: CapabilityValue[] = [];
  let index = openBracket + 1;
  while (true) {
    const token = tokens[index];
    if (token === undefined) return undefined;
    if (isPunct(token, ']')) {
      return { value: { kind: 'array', items, line: token.line }, next: index + 1 };
    }
    const parsed = parseCapabilityValue(tokens, index, depth + 1);
    if (parsed === undefined) return undefined;
    items.push(parsed.value);
    index = parsed.next;
    if (isPunct(tokens[index], ',')) {
      index += 1;
      continue;
    }
    if (isPunct(tokens[index], ']')) {
      const close = tokens[index] as Token;
      return { value: { kind: 'array', items, line: close.line }, next: index + 1 };
    }
    return undefined;
  }
}

function isAbsent(value: CapabilityValue | undefined): boolean {
  return value === undefined || value.kind === 'undefined';
}

/**
 * Rules 6-9. Returns the resolved capabilities for the report (defaults and
 * sorted arrays, exactly as `defineTool` would produce them) and pushes at most
 * one issue per rule.
 */
function checkCapabilities(
  root: CapabilityValue,
  issues: ToolSourceIssue[],
): ManifestCapabilities {
  const entries = root.kind === 'object' ? root.entries : new Map<string, CapabilityValue>();

  const read: string[] = [];
  const write: string[] = [];
  let fsIssue = false;
  const fsValue = entries.get('fs');
  if (!isAbsent(fsValue) && fsValue?.kind !== 'object') {
    fsIssue = true;
    issues.push({
      code: 'invalid_fs_grant',
      message: 'capabilities.fs must be a literal object with read and write arrays',
      ...(fsValue === undefined ? {} : { line: fsValue.line }),
    });
  } else if (fsValue !== undefined && fsValue.kind === 'object') {
    for (const field of ['read', 'write'] as const) {
      const target = field === 'read' ? read : write;
      const value = fsValue.entries.get(field);
      if (isAbsent(value)) continue;
      if (value?.kind !== 'array') {
        if (!fsIssue) {
          fsIssue = true;
          issues.push({
            code: 'invalid_fs_grant',
            message: `capabilities.fs.${field} must be a literal array of workspace-relative globs`,
            ...(value === undefined ? {} : { line: value.line }),
          });
        }
        continue;
      }
      for (const item of value.items) {
        if (item.kind !== 'string' || !isWorkspaceRelativeGrant(item.value)) {
          if (!fsIssue) {
            fsIssue = true;
            issues.push({
              code: 'invalid_fs_grant',
              message: `capabilities.fs.${field} must contain workspace-relative globs only (no absolute paths, no "..", no backslashes)`,
              line: item.line,
            });
          }
          continue;
        }
        target.push(item.value.trim());
      }
    }
  }

  const argv: string[] = [];
  let argvIssue = false;
  const processValue = entries.get('process');
  if (!isAbsent(processValue) && processValue?.kind !== 'object') {
    argvIssue = true;
    issues.push({
      code: 'invalid_argv_grant',
      message: 'capabilities.process must be a literal object with an argv array',
      ...(processValue === undefined ? {} : { line: processValue.line }),
    });
  } else if (processValue !== undefined && processValue.kind === 'object') {
    const value = processValue.entries.get('argv');
    if (!isAbsent(value)) {
      if (value?.kind !== 'array') {
        if (!argvIssue) {
          argvIssue = true;
          issues.push({
            code: 'invalid_argv_grant',
            message: 'capabilities.process.argv must be a literal array of bare executable names',
            ...(value === undefined ? {} : { line: value.line }),
          });
        }
      } else {
        for (const item of value.items) {
          const grant = item.kind === 'string' ? item.value.trim() : undefined;
          if (grant === undefined || !isBareExecutableName(grant)) {
            if (!argvIssue) {
              argvIssue = true;
              issues.push({
                code: 'invalid_argv_grant',
                message:
                  'process.argv grants must be bare executable names: no paths, no flags, no empty strings',
                line: item.line,
              });
            }
            continue;
          }
          argv.push(grant);
        }
      }
    }
  }

  // Rule 6 reads the net declaration instead of refusing it: the runtime has
  // `ctx.net.fetch` now, and `capability_undeclared` (below) is what keeps a
  // call honest. A declaration that is not a literal array grants nothing, so
  // the shapes the reader cannot understand fail closed.
  const hosts: string[] = [];
  const netValue = entries.get('net');
  if (netValue !== undefined && netValue.kind === 'object') {
    const value = netValue.entries.get('hosts');
    if (value !== undefined && value.kind === 'array') {
      for (const item of value.items) {
        const grant = item.kind === 'string' ? item.value.trim() : '';
        if (grant.length > 0) hosts.push(grant);
      }
    }
  }

  // Rule 6 also reads env.read: exact names only, so a glob or `'*'` grants
  // nothing here and `defineTool` refuses it at build time.
  const envRead: string[] = [];
  const envValue = entries.get('env');
  if (envValue !== undefined && envValue.kind === 'object') {
    const value = envValue.entries.get('read');
    if (value !== undefined && value.kind === 'array') {
      for (const item of value.items) {
        const name = item.kind === 'string' ? item.value.trim() : '';
        if (ENV_NAME_PATTERN.test(name)) envRead.push(name);
      }
    }
  }

  const limits = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  };
  let limitIssue = false;
  const limitsValue = entries.get('limits');
  if (!isAbsent(limitsValue) && limitsValue?.kind !== 'object') {
    limitIssue = true;
    issues.push({
      code: 'limit_too_large',
      message: `capabilities.limits must be a literal object with positive integers (timeoutMs <= ${CREATOR_LIMITS.timeoutMs}, maxOutputBytes <= ${CREATOR_LIMITS.maxOutputBytes})`,
      ...(limitsValue === undefined ? {} : { line: limitsValue.line }),
    });
  } else if (limitsValue !== undefined && limitsValue.kind === 'object') {
    for (const field of ['timeoutMs', 'maxOutputBytes'] as const) {
      const value = limitsValue.entries.get(field);
      if (isAbsent(value)) continue;
      const ceiling = field === 'timeoutMs' ? CREATOR_LIMITS.timeoutMs : CREATOR_LIMITS.maxOutputBytes;
      if (
        value?.kind !== 'number' ||
        !Number.isInteger(value.value) ||
        value.value <= 0 ||
        value.value > ceiling
      ) {
        if (!limitIssue) {
          limitIssue = true;
          issues.push({
            code: 'limit_too_large',
            message: `capabilities.limits.${field} must be a positive integer no greater than ${ceiling}`,
            ...(value === undefined ? {} : { line: value.line }),
          });
        }
        continue;
      }
      limits[field] = value.value;
    }
  }

  return {
    fs: { read: uniqueSorted(read), write: uniqueSorted(write) },
    process: { argv: uniqueSorted(argv) },
    net: { hosts: uniqueSorted(hosts) },
    env: { read: uniqueSorted(envRead) },
    limits,
  };
}

// ---------------------------------------------------------------------------
// Rule 6, second half: capability_undeclared
//
// The runtime grants `ctx.net.fetch` and `ctx.env` by declaration, so a call the
// manifest does not declare would just be denied at run time. This rule turns
// that into a review issue: it is cheap, it names the name that is missing, and
// it is the only way a generated tool learns the allow-list exists.
// ---------------------------------------------------------------------------

/**
 * The first `ctx.net.fetch` or `ctx.env.<NAME>` the manifest does not declare.
 *
 * It reads the token stream, so it knows exactly what the identifier rule knows:
 * strings and comments are skipped, and a member access is a name. Three shapes
 * are recognised, and the rest is deliberately left alone because guessing
 * would refuse a source that is honest:
 *
 * - `ctx.net.fetch(...)`: refused when `net.hosts` is empty;
 * - `net.fetch(...)`: the same call through a local alias. Rule 4 already
 *   refuses the bare identifier, so this is a backstop, not the main path;
 * - `ctx.env.NAME`: refused when `NAME` is not in `env.read`.
 *
 * A computed access (`ctx.env[name]`) is not modelled: the lint is advisory and
 * the runtime denies the undeclared name anyway (`ctx.env` is exactly the
 * declared ones), which is why the omission is safe.
 */
function findUndeclaredCapability(
  tokens: readonly Token[],
  capabilities: ManifestCapabilities,
): ToolSourceIssue | undefined {
  const declaredEnv = new Set(capabilities.env.read);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.kind !== 'ident') continue;

    if (token.value === 'ctx') {
      if (!isPunct(tokens[index + 1], '.')) continue;
      const member = tokens[index + 2];
      if (!isPunct(tokens[index + 3], '.')) continue;
      const name = tokens[index + 4];
      if (member === undefined || member.kind !== 'ident') continue;
      if (name === undefined || name.kind !== 'ident') continue;
      if (member.value === 'net' && name.value === 'fetch') {
        if (capabilities.net.hosts.length === 0) {
          return {
            code: 'capability_undeclared',
            message:
              'ctx.net.fetch requires capabilities.net.hosts; declare net: { hosts: ["api.example.com"] } (or ["*"])',
            line: name.line,
          };
        }
        continue;
      }
      if (member.value === 'env' && !declaredEnv.has(name.value)) {
        return {
          code: 'capability_undeclared',
          message: `ctx.env.${name.value} is not declared; add "${name.value}" to capabilities.env.read`,
          line: name.line,
        };
      }
      continue;
    }

    // A bare `net.fetch(...)`: `net` is not a property name here, so rule 4
    // refuses the identifier as well. Kept so the message names the missing
    // declaration rather than only the forbidden identifier.
    if (token.value === 'net' && !isPunct(tokens[index - 1], '.')) {
      if (!isPunct(tokens[index + 1], '.')) continue;
      if (!isIdent(tokens[index + 2], 'fetch')) continue;
      if (capabilities.net.hosts.length === 0) {
        return {
          code: 'capability_undeclared',
          message:
            'net.fetch requires capabilities.net.hosts; declare net: { hosts: ["api.example.com"] } (or ["*"])',
          line: token.line,
        };
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Grant shape
// ---------------------------------------------------------------------------

function isWorkspaceRelativeGrant(grant: string): boolean {
  const value = grant.trim();
  if (value.length === 0 || value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || value.startsWith('~')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (value.startsWith('//')) return false;
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false;
    if (segment.includes(':')) return false;
  }
  return true;
}

function isBareExecutableName(value: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/.test(value);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

// ---------------------------------------------------------------------------
// Build helpers
// ---------------------------------------------------------------------------

function buildFailedIssue(error: unknown): ToolSourceIssue {
  const raw = error instanceof Error ? error.message : String(error);
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('at '));
  const detail =
    lines.find((line) => /ERROR:/.test(line)) ?? lines[0] ?? 'the build failed';
  const issue: ToolSourceIssue = {
    code: 'build_failed',
    message:
      detail.length > MAX_REPORTED_MESSAGE
        ? `${detail.slice(0, MAX_REPORTED_MESSAGE)}...`
        : detail,
  };
  const location = /:(\d+):(\d+):/.exec(raw);
  if (location !== null) {
    const line = Number(location[1]);
    if (Number.isInteger(line) && line > 0) issue.line = line;
  }
  return issue;
}

/**
 * The project's own dependencies win. Only when one of them is missing does the
 * creator fall back to the SDK installation, which is what lets a fresh project
 * build before `npm install` and keeps the tests offline.
 */
async function fallbackAliases(root: string): Promise<Record<string, string> | undefined> {
  const path = await import('node:path');
  const { createRequire } = await import('node:module');
  const requireFrom = createRequire(path.join(root, 'package.json'));
  const resolveFrom = (specifier: string): string | undefined => {
    try {
      return requireFrom.resolve(specifier);
    } catch {
      return undefined;
    }
  };

  const localSdk = resolveFrom('z1-tool-sdk');
  const localZod = resolveFrom('zod');
  if (localSdk !== undefined && localZod !== undefined) return undefined;

  const sdkRoot = await findSdkRoot();
  if (sdkRoot === undefined) return undefined;
  const sdkRequire = createRequire(path.join(sdkRoot, 'package.json'));
  const sdkEntry =
    localSdk ??
    (await firstExisting([
      path.join(sdkRoot, 'src', 'index.ts'),
      path.join(sdkRoot, 'dist', 'index.js'),
    ]));
  const zodEntry =
    localZod ??
    (() => {
      try {
        return sdkRequire.resolve('zod');
      } catch {
        return undefined;
      }
    })();
  if (sdkEntry === undefined || zodEntry === undefined) return undefined;
  return { 'z1-tool-sdk': sdkEntry, zod: zodEntry };
}

async function findSdkRoot(): Promise<string | undefined> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth += 1) {
    const text = await fs.readFile(path.join(current, 'package.json'), 'utf8').catch(() => undefined);
    if (text !== undefined) {
      try {
        const parsed = JSON.parse(text) as { name?: unknown };
        if (parsed.name === 'z1-tool-sdk') return current;
      } catch {
        // Keep walking; a malformed package.json higher up is not ours.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

async function firstExisting(candidates: readonly string[]): Promise<string | undefined> {
  const fs = await import('node:fs/promises');
  for (const candidate of candidates) {
    const info = await fs.stat(candidate).catch(() => undefined);
    if (info?.isFile() === true) return candidate;
  }
  return undefined;
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}
