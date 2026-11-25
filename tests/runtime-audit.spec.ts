import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AuditRow, AuditSink } from '../src/runtime/index.js';
import {
  SANDBOX_MAX_AUDIT_ROWS,
  createJsonlAuditSink,
  createMemoryAuditSink,
  createToolRuntime,
} from '../src/runtime/index.js';
import {
  cleanupTempDirs,
  rawManifest,
  rawToolSource,
  tempDir,
  writeRawPackage,
} from './runtime-helpers.js';

afterAll(async () => {
  await cleanupTempDirs();
});

const ALLOW_AND_DENY = `(async () => {
  const attempt = async (fn) => {
    try { await fn(); return 'ok'; } catch (error) { return error.message; }
  };
  const results = [
    await attempt(() => ctx.fs.read('a.txt')),
    await attempt(() => ctx.fs.read('.env')),
    await attempt(() => ctx.fs.read('.git/config')),
    await attempt(() => ctx.process.run({ argv: ['whoami'] })),
    await attempt(() => ctx.net.fetch('https://example.com/secret')),
  ];
  ctx.log('info', 'checking the audit trail');
  return { results };
})()`;

async function auditFixture(
  runBody: string,
  options: { read?: string[]; argv?: string[] } = {},
): Promise<{ dir: string; workspace: string; runtime: Awaited<ReturnType<typeof createToolRuntime>> }> {
  const dir = await tempDir('z1-audit-');
  const manifest = rawManifest({ name: 'tool.audit', read: options.read ?? ['**/*'], argv: options.argv ?? [] });
  await writeRawPackage(dir, rawToolSource(manifest, runBody), manifest);
  const workspace = await tempDir('z1-audit-work-');
  await mkdir(join(workspace, '.git'), { recursive: true });
  await writeFile(join(workspace, 'a.txt'), 'FILE-CONTENT-MARKER', 'utf8');
  await writeFile(join(workspace, '.env'), 'SECRET=1', 'utf8');
  await writeFile(join(workspace, '.git', 'config'), 'gitconfig', 'utf8');
  return { dir, workspace, runtime: await createToolRuntime({ workspace }) };
}

describe('audit rows', () => {
  it('records every allow and every denial with the right decision, code and target', async () => {
    const fixture = await auditFixture(ALLOW_AND_DENY);
    const sink = createMemoryAuditSink();
    const runtime = await createToolRuntime({ workspace: fixture.workspace, audit: sink });

    const result = await runtime.run(fixture.dir, {});
    const outcome = result.value as { results: string[] };
    expect(outcome.results[0]).toBe('ok');
    expect(outcome.results.slice(1)).toHaveLength(4);
    for (const denied of outcome.results.slice(1)) {
      expect(denied).toMatch(/^(secret_path_denied|path_denied|process_argv_denied|net_denied): /);
    }

    // Every call opens with the one `env.read` its `ctx.env` is built from; this
    // manifest declares no names, so the row carries the kind as its target.
    expect(result.audit.map((row) => [row.kind, row.decision, row.code ?? null, row.target])).toEqual([
      ['env.read', 'allow', null, 'env.read'],
      ['fs.read', 'allow', null, 'a.txt'],
      ['fs.read', 'deny', 'secret_path_denied', '<redacted>'],
      ['fs.read', 'deny', 'path_denied', '.git/config'],
      ['process.run', 'deny', 'process_argv_denied', 'whoami'],
      ['net.fetch', 'deny', 'net_denied', '<redacted>'],
      ['log', 'allow', null, 'log'],
    ]);
    for (const row of result.audit) {
      expect(row.tool).toBe('tool.audit');
      expect(row.version).toBe('0.1.0');
      expect(row.ts).toBeGreaterThan(0);
    }

    // The sink sees the same rows as the result, one final flush per call.
    expect(sink.rows).toEqual([...result.audit]);
  });

  it('never records file contents, absolute host paths or denied secret names', async () => {
    const fixture = await auditFixture(`(async () => ({ text: await ctx.fs.read('a.txt') }))()`);
    const sink = createMemoryAuditSink();
    const runtime = await createToolRuntime({ workspace: fixture.workspace, audit: sink });

    const result = await runtime.run(fixture.dir, {});
    expect(result.value).toEqual({ text: 'FILE-CONTENT-MARKER' });

    const serialized = JSON.stringify(result.audit);
    expect(serialized).not.toContain('FILE-CONTENT-MARKER');
    expect(serialized).not.toContain('.env');
    expect(serialized).not.toContain(fixture.workspace);
    expect(serialized).not.toContain(process.cwd());
  });

  it('caps rows per call and writes one audit_limit summary row', async () => {
    const count = SANDBOX_MAX_AUDIT_ROWS + 500;
    const fixture = await auditFixture(
      `(() => { for (let index = 0; index < ${count}; index += 1) ctx.log('debug', 'line ' + index); return { logs: ${count} }; })()`,
    );
    const sink = createMemoryAuditSink();
    const runtime = await createToolRuntime({ workspace: fixture.workspace, audit: sink });

    const result = await runtime.run(fixture.dir, {});
    expect(result.value).toEqual({ logs: count });
    expect(result.audit).toHaveLength(SANDBOX_MAX_AUDIT_ROWS + 1);
    expect(result.audit[SANDBOX_MAX_AUDIT_ROWS]).toMatchObject({
      kind: 'audit',
      decision: 'deny',
      code: 'audit_limit',
      target: 'audit',
    });
    expect(sink.rows).toEqual([...result.audit]);
  });

  it('keeps the call working when the sink throws', async () => {
    const fixture = await auditFixture(`(async () => ({ text: await ctx.fs.read('a.txt') }))()`);
    const warnings: string[] = [];
    const sink: AuditSink = {
      write() {
        throw new Error('sink is on fire');
      },
    };
    const runtime = await createToolRuntime({
      workspace: fixture.workspace,
      audit: sink,
      onLog: (level, message) => warnings.push(`${level}:${message}`),
    });

    const result = await runtime.run(fixture.dir, {});
    expect(result.value).toEqual({ text: 'FILE-CONTENT-MARKER' });
    expect(result.audit.map((row) => [row.kind, row.decision])).toEqual([
      ['env.read', 'allow'],
      ['fs.read', 'allow'],
    ]);
    expect(warnings).toEqual(['warn:the audit sink threw and was ignored: sink is on fire']);
  });

  it('writes one JSON object per line through the JSONL sink', async () => {
    const fixture = await auditFixture(`(async () => ({ text: await ctx.fs.read('a.txt') }))()`);
    const file = join(fixture.workspace, 'audit.log');
    const runtime = await createToolRuntime({
      workspace: fixture.workspace,
      audit: createJsonlAuditSink(file),
    });

    await runtime.run(fixture.dir, {});
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    const row = JSON.parse(lines[1] ?? '{}') as AuditRow;
    expect(row).toMatchObject({ kind: 'fs.read', decision: 'allow', target: 'a.txt' });
  });

  it('records a denial for an unknown bridge kind instead of running it', async () => {
    const fixture = await auditFixture(
      `(async () => {
        try { __z1_invoke('fs.rm', '{"path":"a.txt"}'); } catch (error) { return { message: error.message }; }
        return { message: 'allowed' };
      })()`,
    );
    const sink = createMemoryAuditSink();
    const runtime = await createToolRuntime({ workspace: fixture.workspace, audit: sink });

    const result = await runtime.run(fixture.dir, {});
    expect(result.value).toMatchObject({ message: expect.stringContaining('capability_denied') });
    expect(result.audit).toEqual([
      expect.objectContaining({ kind: 'fs.rm', decision: 'deny', code: 'capability_denied' }),
    ]);
  });

  it('rejects an audit sink that is neither a sink nor an array', async () => {
    const workspace = await tempDir('z1-audit-bad-');
    await expect(
      createToolRuntime({ workspace, audit: { write: 'nope' } as unknown as AuditSink }),
    ).rejects.toThrow(/audit/i);
  });
});
