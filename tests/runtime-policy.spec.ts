import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRuntimeError } from '../src/runtime/errors.js';
import type { ToolRuntimeCode } from '../src/runtime/errors.js';
import {
  assertEnvNames,
  assertFetchHeaders,
  assertFetchMethod,
  assertFetchUrl,
  assertGlobPattern,
  assertListable,
  assertProcessArgv,
  assertReadable,
  assertWritable,
  assertWorkspaceDirectory,
  ensurePolicyHost,
  filterGlobResults,
  hostAllowed,
  isGrantedDirectory,
  isGrantedPath,
} from '../src/runtime/policy.js';
import { SANDBOX_MAX_ENV_ENTRIES, SANDBOX_MAX_NET_HEADERS } from '../src/runtime/limits.js';
import { capabilities, cleanupTempDirs, tempDir } from './runtime-helpers.js';

const ALL_READ = capabilities({ read: ['**/*'], write: ['**/*'], argv: ['node'] });

beforeAll(async () => {
  await ensurePolicyHost();
});

afterAll(async () => {
  await cleanupTempDirs();
});

function policyError(fn: () => unknown): ToolRuntimeError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolRuntimeError);
    return error as ToolRuntimeError;
  }
  throw new Error('expected the policy to refuse, but it allowed');
}

function expectCode(fn: () => unknown, code: ToolRuntimeCode): ToolRuntimeError {
  const error = policyError(fn);
  expect(error.code, error.message).toBe(code);
  return error;
}

describe('path policy', () => {
  it('refuses traversal, absolute paths and malformed input with the right code', async () => {
    const workspace = await tempDir('z1-policy-paths-');
    const cases: ReadonlyArray<readonly [string, ToolRuntimeCode]> = [
      ['../escape', 'path_outside_workspace'],
      ['a/../../b', 'path_outside_workspace'],
      ['/etc/passwd', 'path_outside_workspace'],
      ['C:/Windows/win.ini', 'path_outside_workspace'],
      ['\\\\srv\\share', 'path_outside_workspace'],
      ['//srv/share', 'path_outside_workspace'],
      ['~/x', 'path_outside_workspace'],
      ['a\\b', 'invalid_arguments'],
      ['a\0b', 'invalid_arguments'],
      ['', 'invalid_arguments'],
      ['x'.repeat(1025), 'invalid_arguments'],
      ['a//b', 'invalid_arguments'],
      ['a/./b', 'invalid_arguments'],
    ];
    for (const [input, code] of cases) {
      expectCode(() => assertReadable(input, ALL_READ, workspace), code);
    }
  });

  it('refuses denied segments anywhere in the path', async () => {
    const workspace = await tempDir('z1-policy-segments-');
    const cases = [
      '.git/config',
      'sub/.git/config',
      '.z1/runs.db',
      'z1/.z1-sessions/x',
      '.ssh/id_rsa',
      '.aws/x',
      'docs/.GIT/config',
    ];
    for (const input of cases) {
      expectCode(() => assertReadable(input, ALL_READ, workspace), 'path_denied');
    }
  });

  it('does not deny the .z2q tools root, which is what SECURITY.md warns about', async () => {
    const workspace = await tempDir('z1-policy-z2q-');
    await mkdir(join(workspace, '.z2q', 'tools', 'tool.other', '0.1.0'), { recursive: true });
    await writeFile(
      join(workspace, '.z2q', 'tools', 'tool.other', '0.1.0', 'approval.json'),
      '{}',
      'utf8',
    );
    const all = capabilities({ read: ['**/*'] });

    // `.z1` is a denied segment; `.z2q` is not. A tool whose workspace is the
    // project root and whose grant covers it can therefore read the installed
    // tools root and the proposals directory — the residual SECURITY.md records
    // under "Tool Creator", where it says to keep the tools root elsewhere.
    const installed = '.z2q/tools/tool.other/0.1.0/approval.json';
    expect(assertReadable(installed, all, workspace)).toBe(installed);
    expectCode(() => assertReadable('.z1/sessions/a.json', all, workspace), 'path_denied');
  });

  it('refuses secret-like file names', async () => {
    const workspace = await tempDir('z1-policy-secrets-');
    for (const input of ['.env', '.env.local', 'id_rsa', 'server.pem', 'creds.key', '.npmrc', 'sub/.env.production']) {
      expectCode(() => assertReadable(input, ALL_READ, workspace), 'secret_path_denied');
    }
  });

  it('requires a matching read grant and matches patterns with the shared glob matcher', async () => {
    const workspace = await tempDir('z1-policy-grants-');
    expectCode(() => assertReadable('src/a.ts', capabilities(), workspace), 'capability_denied');

    const docs = capabilities({ read: ['docs/**'] });
    expect(assertReadable('docs/guide/a.md', docs, workspace)).toBe('docs/guide/a.md');
    expectCode(() => assertReadable('src/a.ts', docs, workspace), 'capability_denied');
  });

  it('refuses a junction or symlink that reaches outside the workspace', async (context) => {
    const workspace = await tempDir('z1-policy-link-');
    const outside = await tempDir('z1-policy-outside-');
    await writeFile(join(outside, 'secret.txt'), 'outside', 'utf8');
    const link = join(workspace, 'link');
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      context.skip();
      return;
    }
    expectCode(() => assertReadable('link/secret.txt', ALL_READ, workspace), 'path_outside_workspace');
  });

  it('names the workspace root for list and cwd without inventing a path', async () => {
    const workspace = await tempDir('z1-policy-root-');
    await mkdir(join(workspace, 'sub'), { recursive: true });

    expect(assertListable('.', capabilities({ read: ['sub/**'] }), workspace)).toBe('');
    expectCode(() => assertListable('.', capabilities(), workspace), 'capability_denied');
    expect(assertListable('sub', capabilities({ read: ['sub'] }), workspace)).toBe('sub');
    expect(assertListable('sub', capabilities({ read: ['sub*'] }), workspace)).toBe('sub');

    expect(assertWorkspaceDirectory('.', workspace)).toBe(workspace);
    expect(assertWorkspaceDirectory('sub', workspace)).toBe(join(workspace, 'sub'));
    expectCode(() => assertWorkspaceDirectory('../x', workspace), 'path_outside_workspace');
    expectCode(() => assertWorkspaceDirectory('missing', workspace), 'path_outside_workspace');
  });

  it('applies the write rules: grant, existing parent, not a directory, realpath inside', async () => {
    const workspace = await tempDir('z1-policy-write-');
    await mkdir(join(workspace, 'out'), { recursive: true });
    await mkdir(join(workspace, 'dir'), { recursive: true });

    expectCode(
      () => assertWritable('out/a.txt', capabilities(), workspace),
      'capability_denied',
    );
    expect(assertWritable('out/a.txt', capabilities({ write: ['out/**'] }), workspace)).toBe(
      'out/a.txt',
    );
    expectCode(
      () => assertWritable('missing/a.txt', capabilities({ write: ['**/*'] }), workspace),
      'path_outside_workspace',
    );
    expectCode(
      () => assertWritable('.git/config', capabilities({ write: ['**/*'] }), workspace),
      'path_denied',
    );
    expectCode(
      () => assertWritable('dir', capabilities({ write: ['**/*'] }), workspace),
      'path_denied',
    );
    expectCode(
      () => assertWritable('../escape.txt', capabilities({ write: ['**/*'] }), workspace),
      'path_outside_workspace',
    );
  });

  it('validates glob patterns and filters results through the deny lists and grants', async () => {
    const workspace = await tempDir('z1-policy-glob-');
    await mkdir(join(workspace, '.git'), { recursive: true });
    await writeFile(join(workspace, '.git', 'config'), 'secret', 'utf8');
    await writeFile(join(workspace, '.env'), 'SECRET=1', 'utf8');
    await writeFile(join(workspace, 'src.ts'), 'ok', 'utf8');

    expect(assertGlobPattern('**/*')).toBe('**/*');
    expectCode(() => assertGlobPattern('../**'), 'path_outside_workspace');
    expectCode(() => assertGlobPattern('/abs/**'), 'path_outside_workspace');
    expectCode(() => assertGlobPattern('a\\b'), 'invalid_arguments');
    expectCode(() => assertGlobPattern(`${'a/'.repeat(300)}*`), 'invalid_arguments');

    const filtered = filterGlobResults(
      ['.git/config', '.env', 'src.ts', 'notes/readme.md', '../escape.txt', 'C:/x'],
      capabilities({ read: ['**/*'] }),
      workspace,
    );
    expect(filtered).toEqual(['src.ts', 'notes/readme.md']);

    const narrow = filterGlobResults(['src.ts', 'notes/readme.md'], capabilities({ read: ['notes/**'] }), workspace);
    expect(narrow).toEqual(['notes/readme.md']);
  });

  it('validates process argv, the executable grant and environment overrides', async () => {
    const workspace = await tempDir('z1-policy-argv-');
    await mkdir(join(workspace, 'sub'), { recursive: true });

    expectCode(
      () => assertProcessArgv(['whoami'], capabilities({ argv: ['node'] })),
      'process_argv_denied',
    );
    expect(() => assertProcessArgv(['node', '-e', '1'], capabilities({ argv: ['node'] }))).not.toThrow();
    expect(() =>
      assertProcessArgv(['C:/tools/node.exe', '-v'], capabilities({ argv: ['node.exe'] })),
    ).not.toThrow();
    expect(() =>
      assertProcessArgv(['NODE', '-v'], capabilities({ argv: ['node'] })),
    ).not.toThrow();

    for (const argv of [
      [],
      ['node', 1 as unknown as string],
      ['node', ''],
      ['node', 'a\0b'],
      new Array(257).fill('node') as string[],
    ]) {
      expectCode(() => assertProcessArgv(argv, capabilities({ argv: ['node'] })), 'invalid_arguments');
    }

    for (const key of ['NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'GIT_DIR', 'PYTHONPATH', 'BASH_ENV', 'ENV', 'SHELL']) {
      expectCode(
        () => assertProcessArgv(['node'], capabilities({ argv: ['node'] }), { env: { [key]: 'x' } }),
        'process_argv_denied',
      );
    }
    expectCode(
      () => assertProcessArgv(['node'], capabilities({ argv: ['node'] }), { env: { PATH: 1 as unknown as string } }),
      'invalid_arguments',
    );
    expect(() =>
      assertProcessArgv(['node'], capabilities({ argv: ['node'] }), { env: { PATH: '/usr/bin' } }),
    ).not.toThrow();
  });
});

describe('NTFS path shapes and real targets', () => {
  it('refuses alternate data streams, device names and rewritten segments (M1)', async () => {
    const workspace = await tempDir('z1-policy-ads-');
    await writeFile(join(workspace, '.env'), 'ENV_SECRET', 'utf8');
    await writeFile(join(workspace, 'server.pem'), 'PEM_SECRET', 'utf8');
    await writeFile(join(workspace, 'a.txt'), 'plain', 'utf8');

    // Controls: the names themselves are refused by the deny list.
    expectCode(() => assertReadable('.env', ALL_READ, workspace), 'secret_path_denied');
    expectCode(() => assertReadable('server.pem', ALL_READ, workspace), 'secret_path_denied');

    const cases: ReadonlyArray<readonly [string, ToolRuntimeCode]> = [
      ['.env::$DATA', 'invalid_arguments'],
      ['.env:stream', 'invalid_arguments'],
      ['server.pem::$DATA', 'invalid_arguments'],
      ['a.txt:hidden', 'invalid_arguments'],
      ['a.txt.', 'invalid_arguments'],
      ['.git.', 'invalid_arguments'],
      ['.git /config', 'invalid_arguments'],
      ['CON', 'invalid_arguments'],
      ['nul.txt', 'invalid_arguments'],
      ['com1', 'invalid_arguments'],
      ['lpt9.log', 'invalid_arguments'],
    ];
    for (const [input, code] of cases) {
      const error = expectCode(() => assertReadable(input, ALL_READ, workspace), code);
      expect(error.message, input).not.toContain('ENV_SECRET');
    }

    // The narrower grant refuses an alternate data stream for the same reason.
    const docs = capabilities({ read: ['docs/**'] });
    expectCode(() => assertReadable('.env::$DATA', docs, workspace), 'invalid_arguments');
    // Case folding does not weaken the deny list.
    expectCode(() => assertReadable('.GIT/config', ALL_READ, workspace), 'path_denied');
  });

  it('checks the deny list on the real target of a junction (M3)', async () => {
    const workspace = await tempDir('z1-policy-junction-');
    await mkdir(join(workspace, '.git'), { recursive: true });
    await writeFile(join(workspace, '.git', 'config'), 'GIT_SECRET', 'utf8');
    await symlink(join(workspace, '.git'), join(workspace, 'repo'), 'junction');

    // The literal path `repo/config` has no denied segment; the real one does.
    const error = expectCode(
      () => assertReadable('repo/config', ALL_READ, workspace),
      'path_denied',
    );
    expect(error.message).toContain('.git');

    // The glob filter applies the same rule.
    expect(filterGlobResults(['repo/config'], ALL_READ, workspace)).toEqual([]);

    // A junction to an ordinary directory still works.
    await mkdir(join(workspace, 'plain'), { recursive: true });
    await writeFile(join(workspace, 'plain', 'a.txt'), 'ok', 'utf8');
    await symlink(join(workspace, 'plain'), join(workspace, 'link'), 'junction');
    expect(assertReadable('link/a.txt', ALL_READ, workspace)).toBe('link/a.txt');

    // A junction outside the workspace is still outside.
    const outside = await tempDir('z1-policy-outside-');
    await symlink(outside, join(workspace, 'escape'), 'junction');
    expectCode(
      () => assertReadable('escape/x.txt', ALL_READ, workspace),
      'path_outside_workspace',
    );
  });

  it('lets a recursive grant list and read its own directory (S2)', async () => {
    const workspace = await tempDir('z1-policy-list-');
    const docs = capabilities({ read: ['docs/**'] });
    expect(assertListable('docs', docs, workspace)).toBe('docs');
    expect(assertListable('', docs, workspace)).toBe('');
    expectCode(() => assertListable('src', docs, workspace), 'capability_denied');

    // A grant for one file also covers its parent directory, because the broker
    // filters the entries through the same grant.
    const one = capabilities({ read: ['docs/a.md'] });
    expect(assertListable('docs', one, workspace)).toBe('docs');

    // A root listing needs at least one read grant; `docs/**` supplies one.
    const none = capabilities({ read: [] });
    expectCode(() => assertListable('', none, workspace), 'capability_denied');
  });
});

describe('net and env policy (rules 11-14)', () => {
  it('matches hosts exactly, ignores a trailing dot, and matches subdomains only through a wildcard', () => {
    expect(hostAllowed('api.example.com', ['api.example.com'])).toBe(true);
    expect(hostAllowed('API.Example.com.', ['api.example.com'])).toBe(true);
    expect(hostAllowed('api.example.com', ['*.example.com'])).toBe(true);
    // The wildcard covers the apex as well: an allowance with a hole in it is
    // worse than either answer.
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(true);
    expect(hostAllowed('a.b.example.com', ['*.example.com'])).toBe(true);
    // A lookalike is not a subdomain.
    expect(hostAllowed('notexample.com', ['*.example.com'])).toBe(false);
    expect(hostAllowed('example.com.evil.test', ['*.example.com'])).toBe(false);
    // `'*'` is any host: the product decision a host makes for full access.
    expect(hostAllowed('anything.test', ['*'])).toBe(true);
    // An IP literal is reachable only when it is listed verbatim (or through '*').
    expect(hostAllowed('127.0.0.1', ['127.0.0.1'])).toBe(true);
    expect(hostAllowed('127.0.0.1', ['0.0.1'])).toBe(false);
    expect(hostAllowed('127.0.0.1', ['localhost'])).toBe(false);
    expect(hostAllowed('', ['*'])).toBe(false);
  });

  it('accepts http and https only, with no credentials, and checks the host every time', () => {
    expect(assertFetchUrl('https://api.example.com/v1?q=1', ['api.example.com'], 'net.fetch').hostname).toBe(
      'api.example.com',
    );
    expect(assertFetchUrl('http://127.0.0.1:8080/x', ['*'], 'net.fetch').port).toBe('8080');

    expectCode(() => assertFetchUrl('file:///etc/passwd', ['*'], 'net.fetch'), 'invalid_arguments');
    expectCode(() => assertFetchUrl('data:text/plain,x', ['*'], 'net.fetch'), 'invalid_arguments');
    expectCode(() => assertFetchUrl('ftp://example.com/x', ['*'], 'net.fetch'), 'invalid_arguments');
    expectCode(
      () => assertFetchUrl('https://user:pass@example.com/', ['example.com'], 'net.fetch'),
      'invalid_arguments',
    );
    expectCode(
      () => assertFetchUrl('https://example.com/\0', ['example.com'], 'net.fetch'),
      'invalid_arguments',
    );
    expectCode(() => assertFetchUrl('not a url', ['*'], 'net.fetch'), 'invalid_arguments');
    expectCode(
      () => assertFetchUrl(`https://example.com/${'a'.repeat(2048)}`, ['example.com'], 'net.fetch'),
      'invalid_arguments',
    );

    const denied = expectCode(
      () => assertFetchUrl('https://api.example.com/', ['other.example.com'], 'net.fetch'),
      'net_denied',
    );
    expect(denied.message).toContain('api.example.com');
  });

  it('upper-cases seven methods and refuses every other one', () => {
    expect(assertFetchMethod(undefined)).toBe('GET');
    expect(assertFetchMethod(null)).toBe('GET');
    expect(assertFetchMethod(' post ')).toBe('POST');
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect(assertFetchMethod(method.toLowerCase())).toBe(method);
    }
    expectCode(() => assertFetchMethod('TRACE'), 'invalid_arguments');
    expectCode(() => assertFetchMethod('CONNECT'), 'invalid_arguments');
    expectCode(() => assertFetchMethod('   '), 'invalid_arguments');
  });

  it('refuses connection-level headers, CR/LF, NUL and more than the cap', () => {
    expect(assertFetchHeaders(undefined)).toEqual({});
    expect(assertFetchHeaders({ 'x-probe': 'yes', 'content-type': 'application/json' })).toEqual({
      'x-probe': 'yes',
      'content-type': 'application/json',
    });

    // A tool must not believe it set a header the broker dropped, so these are
    // refused rather than ignored.
    for (const name of ['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'HOST']) {
      expectCode(() => assertFetchHeaders({ [name]: 'x' }), 'invalid_arguments');
    }
    expectCode(() => assertFetchHeaders({ 'x-probe': 'a\r\nx-injected: 1' }), 'invalid_arguments');
    expectCode(() => assertFetchHeaders({ 'x-probe': 'a\nb' }), 'invalid_arguments');
    expectCode(() => assertFetchHeaders({ 'x-probe': 'a\0b' }), 'invalid_arguments');
    expectCode(() => assertFetchHeaders({ 'x-probe': '' }), 'invalid_arguments');
    expectCode(() => assertFetchHeaders({ 'x-probe': 42 }), 'invalid_arguments');
    expectCode(() => assertFetchHeaders(['x-probe']), 'invalid_arguments');

    const many: Record<string, string> = {};
    for (let index = 0; index <= SANDBOX_MAX_NET_HEADERS; index += 1) many[`x-${index}`] = 'v';
    expectCode(() => assertFetchHeaders(many), 'invalid_arguments');
  });

  it("draws env.read from exact names only: no '*', no globs, no duplicates, no more than the cap", () => {
    expect(assertEnvNames(undefined)).toEqual([]);
    expect(assertEnvNames(['EXA_API_KEY', 'HOME'])).toEqual(['EXA_API_KEY', 'HOME']);
    // A variable may legitimately be called this; the broker's defineProperty
    // is what keeps it off the prototype.
    expect(assertEnvNames(['__proto__'])).toEqual(['__proto__']);

    expectCode(() => assertEnvNames(['*']), 'invalid_arguments');
    expectCode(() => assertEnvNames(['EXA-API-KEY']), 'invalid_arguments');
    expectCode(() => assertEnvNames(['EXA_*']), 'invalid_arguments');
    expectCode(() => assertEnvNames(['1ABC']), 'invalid_arguments');
    expectCode(() => assertEnvNames(['A', 'A']), 'invalid_arguments');
    expectCode(() => assertEnvNames('EXA_API_KEY'), 'invalid_arguments');

    const many = Array.from({ length: SANDBOX_MAX_ENV_ENTRIES + 1 }, (_value, index) => `NAME_${index}`);
    expectCode(() => assertEnvNames(many), 'invalid_arguments');
  });
});

describe.skipIf(process.platform !== 'win32')('case folding on win32 (n5)', () => {
  it('matches a grant and a path regardless of case', async () => {
    const workspace = await tempDir('z1-policy-case-');
    await mkdir(join(workspace, 'docs'), { recursive: true });
    await writeFile(join(workspace, 'docs', 'a.md'), '# a', 'utf8');

    const upperGrant = capabilities({ read: ['Docs/**'] });
    const lowerGrant = capabilities({ read: ['docs/**'] });
    expect(assertReadable('docs/a.md', upperGrant, workspace)).toBe('docs/a.md');
    expect(assertReadable('Docs/a.md', lowerGrant, workspace)).toBe('Docs/a.md');
    expect(isGrantedPath('docs/a.md', upperGrant.fs.read)).toBe(true);
    expect(isGrantedDirectory('Docs', lowerGrant.fs.read)).toBe(true);
  });
});
