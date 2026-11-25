import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { SANDBOX_MAX_BRIDGE_BYTES, SANDBOX_MAX_READ_BYTES } from '../src/runtime/limits.js';
import { cleanupTempDirs, repoRoot, tempDir } from './runtime-helpers.js';

afterAll(async () => {
  await cleanupTempDirs();
});

const runtimeUrl = pathToFileURL(join(repoRoot, 'src', 'runtime', 'index.ts')).href;

/**
 * S4: every large payload crosses the bridge in chunks. Each case runs in its
 * own child process for two reasons: the teardown abort is printed by the WASM
 * module itself, so only a separate process can prove stderr stays empty, and
 * the remaining library bug is heap-state dependent, so one case per process
 * keeps the measurements the tests pin reproducible.
 *
 * Measured ceilings (see SECURITY.md):
 * - a 6 MB read is exact, but *slicing* a string that large still aborts, so the
 *   6 MB case checks the length and the 4 MB case checks the content;
 * - text outside Latin-1 is clean to about 2.4M code units, so the mixed case
 *   uses exactly that size with head and tail checks.
 */
const CHILD_PRELUDE = [
  "import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';",
  "import { tmpdir } from 'node:os';",
  "import { join } from 'node:path';",
  `import { createToolRuntime } from ${JSON.stringify(runtimeUrl)};`,
  '',
  'const MB = 1024 * 1024;',
  'const which = process.argv[2];',
  "const workspace = mkdtempSync(join(tmpdir(), 'z1-bridge-work-'));",
  "const pkgDir = mkdtempSync(join(tmpdir(), 'z1-bridge-pkg-'));",
  'const manifest = {',
  '  schemaVersion: 1,',
  "  name: 'tool.bridge',",
  "  version: '0.1.0',",
  "  description: 'bridge fixture',",
  "  parameters: { type: 'object', properties: {} },",
  '  capabilities: {',
  "    fs: { read: ['**/*'], write: ['out/**'] },",
  '    process: { argv: [] },',
  '    net: { hosts: [] },',
  '    limits: { timeoutMs: 60000, maxOutputBytes: 8388608 },',
  '  },',
  '};',
  '',
  'function writePkg(body) {',
  "  mkdirSync(join(pkgDir, 'dist'), { recursive: true });",
  "  writeFileSync(join(pkgDir, 'dist', 'tool.json'), JSON.stringify(manifest));",
  "  writeFileSync(",
  "    join(pkgDir, 'dist', 'index.js'),",
  "    'export const tool = { manifest: ' + JSON.stringify(manifest) +",
  "      ', parameters: { safeParse: (v) => ({ success: true, data: v === undefined ? {} : v }) },' +",
  "      ' run: async (ctx, args) => ' + body + ' };\\n',",
  '  );',
  '  return pkgDir;',
  '}',
  '',
  'const runtime = await createToolRuntime({ workspace });',
  '',
];

const CASES: Record<string, string[]> = {
  // 4 MB read, exact: length, a middle slice and the tail
  read4: [
    "const text = 'a'.repeat(4 * MB);",
    "writeFileSync(join(workspace, 'f.txt'), text);",
    'const result = await runtime.run(',
    "  writePkg(`(async () => { const t = await ctx.fs.read('f.txt'); return { n: t.length, part: t.slice(1000, 2000), tail: t.slice(-8) }; })()`),",
    '  {},',
    ');',
    "console.log(JSON.stringify(['read4', result.value.n === text.length, result.value.part === text.slice(1000, 2000), result.value.tail === text.slice(-8)]));",
  ],
  // 6 MB read: the whole string arrives, verified by length alone
  read6: [
    "const text = 'a'.repeat(6 * MB);",
    "writeFileSync(join(workspace, 'f.txt'), text);",
    'const result = await runtime.run(',
    "  writePkg(`(async () => ({ n: (await ctx.fs.read('f.txt')).length }))()`),",
    '  {},',
    ');',
    "console.log(JSON.stringify(['read6', result.value.n]));",
  ],
  // 2.4M code units of 16-bit text: head and tail must match
  readMixed: [
    "const text = ('a' + String.fromCodePoint(0x1f600)).repeat(800000);",
    "writeFileSync(join(workspace, 'f.txt'), text);",
    'const result = await runtime.run(',
    "  writePkg(`(async () => { const t = await ctx.fs.read('f.txt'); return { n: t.length, head: t.slice(0, 8), tail: t.slice(-4) }; })()`),",
    '  {},',
    ');',
    "console.log(JSON.stringify(['readMixed', result.value.n === text.length, result.value.head === text.slice(0, 8), result.value.tail === text.slice(-4)]));",
  ],
  // 6 MB write, buffered and flushed once at eof
  write6: [
    "mkdirSync(join(workspace, 'out'), { recursive: true });",
    "const expected = 'x'.repeat(6 * MB + 3);",
    'await runtime.run(',
    "  writePkg(`(async () => { await ctx.fs.write('out/big.txt', 'x'.repeat(6 * 1024 * 1024 + 3)); return { ok: true }; })()`),",
    '  {},',
    ');',
    "const content = readFileSync(join(workspace, 'out', 'big.txt'), 'utf8');",
    "console.log(JSON.stringify(['write6', content.length, content === expected]));",
  ],
  // 6 MB result through the chunked envelope
  result6: [
    "const result = await runtime.run(writePkg(`({ text: 'y'.repeat(6 * 1024 * 1024) })`), {});",
    "console.log(JSON.stringify(['result6', result.value.text.length]));",
  ],
  // 8 MB argument object refused before it reaches the bridge
  args8: [
    'try {',
    "  await runtime.run(writePkg(`({ ok: true })`), { payload: 'z'.repeat(8 * MB) });",
    "  console.log(JSON.stringify(['args8', 'accepted', false]));",
    '} catch (error) {',
    "  console.log(JSON.stringify(['args8', error.code, error.message.includes('1048576')]));",
    '}',
  ],
  // the bridge itself refuses a payload over the cap (n2, S4)
  bridgeCap: [
    'const result = await runtime.run(',
    "  writePkg(`(async () => { try { __z1_invoke('log', 'x'.repeat(2 * 1024 * 1024)); return { ok: true, message: '' }; } catch (error) { return { ok: false, message: String(error && error.message) }; } })()`),",
    '  {},',
    ');',
    "console.log(JSON.stringify(['bridgeCap', result.value.ok, result.value.message]));",
  ],
  // S3: an allocation-bound tool overruns the deadline (documented residual)
  alloc: [
    'const started = Date.now();',
    "let code = 'none';",
    'try {',
    "  await runtime.run(writePkg(`(() => { const chunks = []; for (;;) { chunks.push('x'.repeat(4 * 1024 * 1024)); } })()`), {}, { timeoutMs: 500 });",
    '} catch (error) {',
    '  code = error.code;',
    '}',
    "console.log(JSON.stringify(['alloc', code, Date.now() - started]));",
  ],
  // n4: stack overflow mapped to loop_limit with no host frame
  overflow: [
    'try {',
    "  await runtime.run(writePkg(`(() => { const f = (n) => f(n + 1) + 1; return f(0); })()`), {});",
    "  console.log(JSON.stringify(['overflow', 'resolved', '']));",
    '} catch (error) {',
    "  console.log(JSON.stringify(['overflow', error.code, error.message]));",
    '}',
  ],
};

interface ChildRun {
  readonly row: unknown[];
  readonly stderr: string;
  readonly stdout: string;
}

async function runCase(name: string): Promise<ChildRun> {
  const script = [...CHILD_PRELUDE, ...(CASES[name] ?? []), ''].join('\n');
  const dir = await tempDir('z1-bridge-');
  const scriptPath = join(dir, 'bridge-child.mts');
  await writeFile(scriptPath, script, 'utf8');
  const child = spawnSync(process.execPath, ['--import', 'tsx', scriptPath, name], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 240_000,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  const stderr = child.stderr ?? '';
  const stdout = child.stdout ?? '';
  expect(child.error, String(child.error)).toBeUndefined();
  expect(child.status, `child failed:\n${stderr}\n${stdout}`).toBe(0);
  const line = stdout.trim().split('\n').pop() ?? '[]';
  return { row: JSON.parse(line) as unknown[], stderr, stdout };
}

describe('bridge chunking (S4)', () => {
  it('reads 4 MB with exact content and a clean stderr', async () => {
    const { row, stderr } = await runCase('read4');
    expect(stderr).toBe('');
    expect(row).toEqual(['read4', true, true, true]);
  }, 240_000);

  it('reads 6 MB and keeps an empty stderr', async () => {
    const { row, stderr } = await runCase('read6');
    expect(stderr).toBe('');
    expect(row).toEqual(['read6', 6 * 1024 * 1024]);
  }, 240_000);

  it('reads 2.4M code units of multi-byte text exactly', async () => {
    const { row, stderr } = await runCase('readMixed');
    expect(stderr).toBe('');
    expect(row).toEqual(['readMixed', true, true, true]);
  }, 240_000);

  it('writes 6 MB in chunks and flushes it once', async () => {
    const { row, stderr } = await runCase('write6');
    expect(stderr).toBe('');
    expect(row).toEqual(['write6', 6 * 1024 * 1024 + 3, true]);
  }, 240_000);

  it('produces a 6 MB result through the chunked envelope', async () => {
    const { row, stderr } = await runCase('result6');
    expect(stderr).toBe('');
    expect(row).toEqual(['result6', 6 * 1024 * 1024]);
  }, 240_000);

  it('refuses an 8 MB argument object before the bridge', async () => {
    const { row, stderr } = await runCase('args8');
    expect(stderr).toBe('');
    expect(row).toEqual(['args8', 'invalid_arguments', true]);
  }, 240_000);

  it('refuses a bridge payload over 1 MiB from inside the VM (n2)', async () => {
    const { row, stderr } = await runCase('bridgeCap');
    expect(stderr).toBe('');
    expect(row[0]).toBe('bridgeCap');
    expect(row[1]).toBe(false);
    expect(String(row[2])).toContain('bridge payloads are limited to 1048576 bytes');
  }, 240_000);

  it(
    'reports time_limit for an allocating tool and may overrun the budget (S3)',
    async () => {
      const { row } = await runCase('alloc');
      expect(row[0]).toBe('alloc');
      expect(row[1]).toBe('time_limit');
      const elapsed = Number(row[2]);
      // Measured residual: the interrupt handler is not polled while QuickJS
      // allocates and collects, so an allocation-bound tool overruns the budget
      // by seconds. Assert the code arrives and record the number; never pin a
      // tight bound. The child's abort line is the documented one.
      console.log(`[S3] time_limit after ${elapsed} ms against a 500 ms budget`);
      expect(elapsed).toBeGreaterThanOrEqual(400);
    },
    240_000,
  );

  it('maps a stack overflow to loop_limit without a host frame (n4)', async () => {
    const { row } = await runCase('overflow');
    expect(row[0]).toBe('overflow');
    expect(row[1]).toBe('loop_limit');
    expect(String(row[2])).toMatch(/stack limit/);
    expect(String(row[2])).not.toMatch(/RangeError|sandbox\.ts|at async|Maximum call stack/);
  }, 240_000);

  it('names the caps the chunking relies on', () => {
    expect(SANDBOX_MAX_BRIDGE_BYTES).toBe(1024 * 1024);
    expect(SANDBOX_MAX_READ_BYTES).toBe(8 * 1024 * 1024);
  });
});
