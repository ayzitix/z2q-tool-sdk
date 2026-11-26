import { afterAll, describe, expect, it } from 'vitest';
import type { AuditRow } from '../src/runtime/index.js';
import { createMemoryAuditSink, createToolRuntime } from '../src/runtime/index.js';
import {
  cleanupTempDirs,
  expectRuntimeError,
  rawManifest,
  rawToolSource,
  tempDir,
  writeRawPackage,
} from './runtime-helpers.js';

/**
 * `ctx.env`: the names a manifest declares, and nothing else.
 *
 * Every fixture passes `env: { read, inherit: false }` so a run never depends on
 * the developer's own environment; the one test that pins the inherited default
 * sets and removes the variable itself.
 */

afterAll(async () => {
  await cleanupTempDirs();
});

interface EnvFixture {
  dir: string;
  workspace: string;
}

/** A raw package whose `run` body is `body`, declaring exactly `envRead`. */
async function envFixture(body: string, envRead: readonly string[]): Promise<EnvFixture> {
  const dir = await tempDir('z1-env-');
  const manifest = rawManifest({ name: 'tool.env', envRead: [...envRead] });
  await writeRawPackage(dir, rawToolSource(manifest, body), manifest);
  return { dir, workspace: await tempDir('z1-env-work-') };
}

const SECRET = 'exa-secret-value-1234';

describe('ctx.env', () => {
  it('carries exactly the declared names, frozen, and records the names in the audit', async () => {
    const fixture = await envFixture(
      `(async () => {
        const before = Object.keys(ctx.env);
        let write = 'no throw';
        try { ctx.env.EXA_API_KEY = 'replaced'; } catch (error) { write = String(error && error.name); }
        return {
          key: ctx.env.EXA_API_KEY,
          missingIsUndefined: ctx.env.MISSING_NAME === undefined,
          otherIsUndefined: ctx.env.OTHER === undefined,
          hasOther: 'OTHER' in ctx.env,
          keys: before,
          frozen: Object.isFrozen(ctx.env),
          write,
          afterWrite: ctx.env.EXA_API_KEY,
        };
      })()`,
      ['EXA_API_KEY', 'MISSING_NAME'],
    );
    const sink = createMemoryAuditSink();
    const runtime = await createToolRuntime({
      workspace: fixture.workspace,
      audit: sink,
      env: { read: { EXA_API_KEY: SECRET, OTHER: 'not-declared' }, inherit: false },
    });

    const result = await runtime.run(fixture.dir, {});
    expect(result.value).toEqual({
      key: SECRET,
      missingIsUndefined: true,
      otherIsUndefined: true,
      hasOther: false,
      // MISSING_NAME is declared but absent on this host, so it is not in the object.
      keys: ['EXA_API_KEY'],
      frozen: true,
      write: 'TypeError',
      afterWrite: SECRET,
    });

    // One crossing, for the declared names; the target is the names, never a value.
    expect(result.audit.map((row) => [row.kind, row.decision, row.target])).toEqual([
      ['env.read', 'allow', 'EXA_API_KEY'],
    ]);
    expect(sink.rows).toEqual([...result.audit]);
    const serialized = JSON.stringify(result.audit);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('not-declared');
  });

  it('never resolves an undeclared name, whatever the host passes', async () => {
    const fixture = await envFixture(
      `(async () => ({
        key: ctx.env.EXA_API_KEY,
        otherIsUndefined: ctx.env.SECRET_OTHER === undefined,
        keys: Object.keys(ctx.env),
      }))()`,
      ['EXA_API_KEY'],
    );
    const runtime = await createToolRuntime({
      workspace: fixture.workspace,
      env: { read: { EXA_API_KEY: SECRET, SECRET_OTHER: 'host-supplied-value' }, inherit: false },
    });

    const result = await runtime.run(fixture.dir, {});
    expect(result.value).toEqual({
      key: SECRET,
      otherIsUndefined: true,
      keys: ['EXA_API_KEY'],
    });
  });

  it('grants nothing with env: false, even for a declared name', async () => {
    const fixture = await envFixture(
      `(async () => ({ key: ctx.env.EXA_API_KEY === undefined, keys: Object.keys(ctx.env) }))()`,
      ['EXA_API_KEY'],
    );
    const runtime = await createToolRuntime({
      workspace: fixture.workspace,
      env: false,
    });

    const result = await runtime.run(fixture.dir, {});
    expect(result.value).toEqual({ key: true, keys: [] });
    // The declaration still pays for the crossing; it just resolves to nothing.
    expect(result.audit.map((row) => [row.kind, row.target])).toEqual([
      ['env.read', 'env.read'],
    ]);
  });

  it('resolves a declared name from the host when a runtime inherits, and not after inherit: false', async () => {
    const name = 'Z1_ENV_SPEC_INHERITED';
    process.env[name] = 'inherited-host-value';
    try {
      const fixture = await envFixture(`(async () => ({ value: ctx.env.${name} }))()`, [name]);
      const inherited = await createToolRuntime({ workspace: fixture.workspace });
      expect((await inherited.run(fixture.dir, {})).value).toEqual({
        value: 'inherited-host-value',
      });

      const isolated = await createToolRuntime({
        workspace: fixture.workspace,
        env: { inherit: false },
      });
      expect((await isolated.run(fixture.dir, {})).value).toEqual({});
    } finally {
      delete process.env[name];
    }
  });

  it('masks an 8+ character secret in ctx.log and leaves a short value alone', async () => {
    const fixture = await envFixture(
      `(async () => {
        ctx.log('info', 'token ' + ctx.env.EXA_API_KEY);
        ctx.log('warn', 'tiny ' + ctx.env.TINY);
        return { logged: true };
      })()`,
      ['EXA_API_KEY', 'TINY'],
    );
    const logs: string[] = [];
    const rows: AuditRow[] = [];
    const runtime = await createToolRuntime({
      workspace: fixture.workspace,
      audit: rows,
      env: { read: { EXA_API_KEY: SECRET, TINY: 'abc' }, inherit: false },
      onLog: (level, message) => logs.push(`${level}:${message}`),
    });

    const result = await runtime.run(fixture.dir, {});
    expect(result.value).toEqual({ logged: true });
    expect(logs).toEqual(['info:token [redacted]', 'warn:tiny abc']);
    const serialized = JSON.stringify([result.audit, rows]);
    expect(serialized).not.toContain(SECRET);
    // The sink really saw the rows, so the check above is not vacuous.
    expect(rows.filter((row) => row.kind === 'log')).toHaveLength(2);
  });

  it('resolves a declared name from the workspace .env, then from the host', async () => {
    const fixture = await envFixture(
      `(async () => ({ key: String(ctx.env.EXA_API_KEY), both: String(ctx.env.OTHER) }))()`,
      ['EXA_API_KEY', 'OTHER'],
    );
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    // The file wins over an inherited value, and `read` wins over the file: the
    // precedence is read > .env > process.env.
    await writeFile(
      join(fixture.workspace, '.env'),
      ['EXA_API_KEY=from-dotenv', 'OTHER=from-dotenv', ''].join(String.fromCharCode(10)),
    );
    const runtime = await createToolRuntime({
      workspace: fixture.workspace,
      env: { file: '.env', read: { OTHER: 'from-read' }, inherit: false },
    });

    const result = await runtime.run(fixture.dir, {});
    expect(result.value).toEqual({ key: 'from-dotenv', both: 'from-read' });
  });

  it('treats a missing .env as no values, not a failure', async () => {
    const fixture = await envFixture(`(async () => ({ key: String(ctx.env.EXA_API_KEY) }))()`, [
      'EXA_API_KEY',
    ]);
    const runtime = await createToolRuntime({
      workspace: fixture.workspace,
      env: { file: '.env', inherit: false },
    });

    const result = await runtime.run(fixture.dir, {});
    expect(result.value).toEqual({ key: 'undefined' });
  });

  it("refuses a hand-written manifest that asks for every name with '*'", async () => {
    const fixture = await envFixture(`(async () => ({ keys: Object.keys(ctx.env) }))()`, ['*']);
    const runtime = await createToolRuntime({ workspace: fixture.workspace });

    const error = await expectRuntimeError(() => runtime.run(fixture.dir, {}), 'invalid_arguments');
    // A declaration the runtime cannot read must not look like one it honoured.
    expect(error.message).toContain('env.read');
  });
});
