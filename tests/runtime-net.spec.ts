import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ToolManifest } from '../src/index.js';
import { createToolRuntime } from '../src/runtime/index.js';
import { SANDBOX_MAX_BRIDGE_BYTES, SANDBOX_MAX_NET_BODY_BYTES } from '../src/runtime/limits.js';
import {
  cleanupTempDirs,
  expectRuntimeError,
  rawManifest,
  rawToolSource,
  repoRoot,
  tempDir,
  writeRawPackage,
} from './runtime-helpers.js';

/**
 * `ctx.net.fetch` against a real loopback server.
 *
 * The server runs in its **own child process** on purpose: the relay blocks the
 * host thread with `spawnSync`, so a `node:http` server inside the test process
 * cannot accept a connection while a fetch is in flight (measured: the request
 * hangs until the helper's own `AbortSignal.timeout` fires). One process serves,
 * one process calls, nothing leaves the machine: every URL here is
 * `127.0.0.1`, `localhost` or a reserved `.test` name.
 *
 * Each server appends `METHOD /path` to a log file before it answers, which is
 * what lets a test prove that a denied host received **zero** requests rather
 * than a refused connection.
 */

const PATTERN = 'abcdefghij';
/** A body the brief asks to see intact: 3 MiB, over two 1 MiB bridge caps. */
const BIG_BYTES = 3 * 1024 * 1024;
const HUGE_BYTES = SANDBOX_MAX_NET_BODY_BYTES + 1024 * 1024;

const SERVER_SOURCE = String.raw`
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const [logDir, tag, redirectTarget] = process.argv.slice(1);
const logFile = join(logDir, tag + '.log');
const PATTERN = 'abcdefghij';
const BIG = ${BIG_BYTES};
const HUGE = ${HUGE_BYTES};
const bigBody = PATTERN.repeat(Math.ceil(BIG / PATTERN.length)).slice(0, BIG);

const server = http.createServer((req, res) => {
  const url = new URL(req.url === undefined ? '/' : req.url, 'http://127.0.0.1');
  appendFileSync(logFile, req.method + ' ' + url.pathname + '\n');
  if (url.pathname === '/slow') return;
  if (url.pathname === '/hello') {
    res.writeHead(200, { 'content-type': 'application/json', 'x-answer': '42' });
    res.end(JSON.stringify({ hello: 'world', method: req.method, path: url.pathname }));
    return;
  }
  if (url.pathname === '/echo') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-answer': '42' });
      res.end(JSON.stringify({
        method: req.method,
        body: body,
        probe: req.headers['x-probe'] === undefined ? null : req.headers['x-probe'],
        type: req.headers['content-type'] === undefined ? null : req.headers['content-type']
      }));
    });
    return;
  }
  if (url.pathname === '/redirect-allowed') {
    res.writeHead(302, { location: '/hello' });
    res.end();
    return;
  }
  if (url.pathname === '/redirect-denied') {
    res.writeHead(302, { location: 'http://' + redirectTarget + '/taken' });
    res.end();
    return;
  }
  if (url.pathname === '/big') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(bigBody);
    return;
  }
  if (url.pathname === '/huge') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('x'.repeat(HUGE));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(0, () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n');
});
`;

interface LoopbackServer {
  readonly port: number;
  /** `METHOD /path` for every request the server saw since the last reset. */
  requests(): string[];
  /** Forget what the server saw, so one test asserts on its own requests only. */
  reset(): void;
  close(): void;
}

/** Start one server child and wait for the port it prints when it listens. */
async function startServer(logDir: string, tag: string, redirectTarget = ''): Promise<LoopbackServer> {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', SERVER_SOURCE, logDir, tag, redirectTarget],
    { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
  );
  const port = await new Promise<number>((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error(`server ${tag} did not start`)), 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      if (!buffered.includes('\n')) return;
      clearTimeout(timer);
      const line = buffered.split('\n')[0] ?? '';
      try {
        resolve((JSON.parse(line) as { port: number }).port);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const logFile = join(logDir, tag + '.log');
  return {
    port,
    reset(): void {
      rmSync(logFile, { force: true });
    },
    requests(): string[] {
      if (!existsSync(logFile)) return [];
      return readFileSync(logFile, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0);
    },
    close(): void {
      child.kill();
    },
  };
}

let logDir = '';
/** Answers on 127.0.0.1 only. The manifests below list this host. */
let allowed: LoopbackServer;
/** Answers on every loopback address, addressed as `localhost` and never listed. */
let denied: LoopbackServer;

beforeAll(async () => {
  logDir = await tempDir('z1-net-log-');
  // The denied server starts first: the allowed one redirects at its address.
  denied = await startServer(logDir, 'denied');
  allowed = await startServer(logDir, 'allowed', `localhost:${denied.port}`);
});

beforeEach(() => {
  allowed?.reset();
  denied?.reset();
});

afterAll(async () => {
  allowed?.close();
  denied?.close();
  await cleanupTempDirs();
});

interface NetFixture {
  dir: string;
  workspace: string;
  manifest: ToolManifest;
}

/** A raw package whose `run` body is `body`, with the given net declaration. */
async function netFixture(
  body: string,
  options: { hosts?: string[]; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<NetFixture> {
  const dir = await tempDir('z1-net-');
  const manifest = rawManifest({
    name: 'tool.net',
    hosts: options.hosts ?? ['127.0.0.1'],
    limits: {
      timeoutMs: options.timeoutMs ?? 30_000,
      maxOutputBytes: options.maxOutputBytes ?? 1_048_576,
    },
  });
  await writeRawPackage(dir, rawToolSource(manifest, body), manifest);
  return { dir, workspace: await tempDir('z1-net-work-'), manifest };
}

const allowedBase = (): string => `http://127.0.0.1:${allowed.port}`;
const deniedBase = (): string => `http://localhost:${denied.port}`;

/**
 * Write the child script that fetches `url` and prints the pieces of the body it
 * received. It runs with `tsx` so it can import the runtime from source, exactly
 * like `tests/runtime-bridge.spec.ts`.
 */
async function writeChildScript(
  scriptPath: string,
  runtimeUrl: string,
  url: string,
  manifest: ToolManifest,
): Promise<void> {
  const bundle = `export const tool = {
  manifest: ${JSON.stringify(manifest)},
  parameters: { safeParse: (value) => ({ success: true, data: value === undefined ? {} : value }) },
  run: async (ctx) => {
    const response = await ctx.net.fetch(${JSON.stringify(url)});
    return {
      length: response.body.length,
      textLength: response.text.length,
      head: response.body.slice(0, 16),
      middle: response.body.slice(1572864, 1572880),
      tail: response.body.slice(-16),
    };
  },
};
`;
  const lines = [
    "import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    `import { createToolRuntime } from ${JSON.stringify(runtimeUrl)};`,
    '',
    `const manifest = ${JSON.stringify(manifest)};`,
    `const bundle = ${JSON.stringify(bundle)};`,
    "const workspace = mkdtempSync(join(tmpdir(), 'z1-net-big-work-'));",
    "const dir = mkdtempSync(join(tmpdir(), 'z1-net-big-pkg-'));",
    "mkdirSync(join(dir, 'dist'), { recursive: true });",
    "writeFileSync(join(dir, 'dist', 'tool.json'), JSON.stringify(manifest));",
    "writeFileSync(join(dir, 'dist', 'index.js'), bundle);",
    'const runtime = await createToolRuntime({ workspace });',
    'const result = await runtime.run(dir, {});',
    'console.log(JSON.stringify(result.value));',
    '',
  ];
  await writeFile(scriptPath, lines.join('\n'), 'utf8');
}

describe('ctx.net.fetch over loopback', () => {
  it('performs a GET and returns ok, status, the final url, lower-cased headers, text and json()', async () => {
    const fixture = await netFixture(`(async () => {
      const response = await ctx.net.fetch(${JSON.stringify(`${allowedBase()}/hello`)});
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        keys: Object.keys(response.headers),
        answer: response.headers['x-answer'],
        type: response.headers['content-type'],
        text: response.text,
        same: response.text === response.body,
        json: response.json(),
        destructured: (({ json }) => json())(response),
      };
    })()`);
    const runtime = await createToolRuntime({ workspace: fixture.workspace });

    const result = await runtime.run(fixture.dir, {});
    expect(result.value).toEqual({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: `${allowedBase()}/hello`,
      keys: expect.any(Array),
      answer: '42',
      type: 'application/json',
      text: '{"hello":"world","method":"GET","path":"/hello"}',
      same: true,
      json: { hello: 'world', method: 'GET', path: '/hello' },
      // `json` closes over the body, so a destructured call works.
      destructured: { hello: 'world', method: 'GET', path: '/hello' },
    });
    const keys = (result.value as { keys: string[] }).keys;
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key).toBe(key.toLowerCase());
    expect(allowed.requests()).toContain('GET /hello');
  });

  it('sends a POST body and headers and parses the echoed JSON', async () => {
    const fixture = await netFixture(`(async () => {
      const response = await ctx.net.fetch(${JSON.stringify(`${allowedBase()}/echo`)}, {
        method: 'post',
        headers: { 'content-type': 'application/json', 'x-probe': 'yes' },
        body: JSON.stringify({ hello: 'world' }),
      });
      return { status: response.status, ok: response.ok, echoed: response.json() };
    })()`);
    const runtime = await createToolRuntime({ workspace: fixture.workspace });

    const result = await runtime.run(fixture.dir, {});
    expect(result.value).toEqual({
      status: 200,
      ok: true,
      echoed: {
        // The manifest said `post`; the broker upper-cases it before the relay.
        method: 'POST',
        body: '{"hello":"world"}',
        probe: 'yes',
        type: 'application/json',
      },
    });
    expect(allowed.requests()).toContain('POST /echo');
  });

  it('denies a host the manifest does not list, without sending a request', async () => {
    const fixture = await netFixture(`(async () => ctx.net.fetch(${JSON.stringify(`${deniedBase()}/taken`)}))()`);
    const runtime = await createToolRuntime({ workspace: fixture.workspace });

    const error = await expectRuntimeError(() => runtime.run(fixture.dir, {}), 'net_denied');
    expect(error.message).toContain('localhost');
    // The denial is local: the server never sees a connection.
    expect(denied.requests()).toEqual([]);
  });

  it("allows any host when the manifest declares '*'", async () => {
    const fixture = await netFixture(
      `(async () => {
        const listed = await ctx.net.fetch(${JSON.stringify(`${allowedBase()}/hello`)});
        const other = await ctx.net.fetch(${JSON.stringify(`${deniedBase()}/hello`)});
        return { listed: listed.status, other: other.status, host: other.url.includes('localhost') };
      })()`,
      { hosts: ['*'] },
    );
    const runtime = await createToolRuntime({ workspace: fixture.workspace });

    const result = await runtime.run(fixture.dir, {});
    expect(result.value).toEqual({ listed: 200, other: 200, host: true });
    expect(denied.requests()).toContain('GET /hello');
  });

  it('fails with net_disabled when the runtime passes net: false, even with a declaration', async () => {
    const fixture = await netFixture(`(async () => ctx.net.fetch(${JSON.stringify(`${allowedBase()}/hello`)}))()`);
    const runtime = await createToolRuntime({ workspace: fixture.workspace, net: false });

    const error = await expectRuntimeError(() => runtime.run(fixture.dir, {}), 'net_disabled');
    expect(error.message).toContain('net: false');
    expect(allowed.requests()).toEqual([]);
  });

  it('follows a redirect whose target the allow-list covers', async () => {
    const fixture = await netFixture(`(async () => {
      const response = await ctx.net.fetch(${JSON.stringify(`${allowedBase()}/redirect-allowed`)});
      return { status: response.status, url: response.url, json: response.json() };
    })()`);
    const runtime = await createToolRuntime({ workspace: fixture.workspace });

    const result = await runtime.run(fixture.dir, {});
    expect(result.value).toEqual({
      status: 200,
      // `url` is the final URL, after the hop.
      url: `${allowedBase()}/hello`,
      json: { hello: 'world', method: 'GET', path: '/hello' },
    });
    expect(allowed.requests()).toEqual(['GET /redirect-allowed', 'GET /hello']);
  });

  it('refuses a redirect hop to a denied host before the second request is made', async () => {
    const fixture = await netFixture(`(async () => {
      const response = await ctx.net.fetch(${JSON.stringify(`${allowedBase()}/redirect-denied`)});
      return { status: response.status, url: response.url };
    })()`);
    const runtime = await createToolRuntime({ workspace: fixture.workspace });

    const error = await expectRuntimeError(() => runtime.run(fixture.dir, {}), 'net_denied');
    expect(error.message).toContain('redirect');
    // The first hop happened once; the denied host saw nothing at all.
    expect(allowed.requests()).toEqual(['GET /redirect-denied']);
    expect(denied.requests()).toEqual([]);
  });

  it('refuses a response body over the cap with output_too_large', async () => {
    const fixture = await netFixture(`(async () => ctx.net.fetch(${JSON.stringify(`${allowedBase()}/huge`)}))()`);
    const runtime = await createToolRuntime({ workspace: fixture.workspace });

    const error = await expectRuntimeError(() => runtime.run(fixture.dir, {}), 'output_too_large');
    expect(error.message).toContain(String(SANDBOX_MAX_NET_BODY_BYTES));
  });

  it('refuses a request body over the cap with invalid_arguments', async () => {
    // Over the 1 MiB request cap, so the bridge refuses the payload first; both
    // checks are `invalid_arguments` and the message names a byte limit.
    const fixture = await netFixture(`(async () => ctx.net.fetch(${JSON.stringify(`${allowedBase()}/echo`)}, {
      method: 'POST',
      body: 'x'.repeat(1024 * 1024 + 64),
    }))()`);
    const runtime = await createToolRuntime({ workspace: fixture.workspace });

    const error = await expectRuntimeError(() => runtime.run(fixture.dir, {}), 'invalid_arguments');
    // The bridge payload that carries the body is over 1 MiB, so the bridge
    // refuses it first; the message still names a byte limit, not a stack.
    expect(error.message).toContain(String(SANDBOX_MAX_BRIDGE_BYTES));
    expect(allowed.requests()).toEqual([]);
  });

  it('fails with net_failed inside the manifest timeout when the server never answers', async () => {
    const fixture = await netFixture(
      `(async () => ctx.net.fetch(${JSON.stringify(`${allowedBase()}/slow`)}))()`,
      { timeoutMs: 1_000 },
    );
    const runtime = await createToolRuntime({ workspace: fixture.workspace });

    const started = Date.now();
    const error = await expectRuntimeError(() => runtime.run(fixture.dir, {}), 'net_failed');
    const elapsed = Date.now() - started;
    // The tool sees `net_failed`, never the call's own `time_limit`; the helper
    // reserves a slice of the budget so its AbortSignal fires first.
    expect(error.message).not.toContain('time_limit');
    expect(elapsed).toBeLessThan(3_000);
    expect(allowed.requests()).toEqual(['GET /slow']);
  });

  it('refuses a file:// URL and a host header before any request', async () => {
    const fixture = await netFixture(`(async () => {
      const attempt = async (fn) => {
        try { await fn(); return 'ok'; } catch (error) { return String(error.message); }
      };
      return {
        file: await attempt(() => ctx.net.fetch('file:///etc/passwd')),
        header: await attempt(() => ctx.net.fetch(${JSON.stringify(`${allowedBase()}/hello`)}, {
          headers: { host: 'internal.example' },
        })),
      };
    })()`);
    const runtime = await createToolRuntime({ workspace: fixture.workspace });

    const result = await runtime.run(fixture.dir, {});
    const value = result.value as { file: string; header: string };
    expect(value.file).toMatch(/^invalid_arguments: /);
    expect(value.file).toContain('http');
    expect(value.header).toMatch(/^invalid_arguments: /);
    expect(value.header).toContain('host');
    expect(allowed.requests()).toEqual([]);
  });

  it('delivers a 3 MiB body intact and disposes the runtime without an abort', async () => {
    // Its own process: the teardown abort is printed by the WASM module, so only
    // a separate process can prove stderr stays empty (`SECURITY.md`).
    const scriptDir = await tempDir('z1-net-big-');
    const scriptPath = join(scriptDir, 'net-big-child.mts');
    const runtimeUrl = pathToFileURL(join(repoRoot, 'src', 'runtime', 'index.ts')).href;
    const url = `${allowedBase()}/big`;
    const manifest = rawManifest({ name: 'tool.big', hosts: ['127.0.0.1'], limits: { timeoutMs: 60_000 } });
    await writeChildScript(scriptPath, runtimeUrl, url, manifest);

    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
      cwd: repoRoot,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });

    expect(stderr, `child stderr:\n${stderr}`).toBe('');
    expect(status).toBe(0);
    const line = stdout.trim().split('\n').pop() ?? '{}';
    const value = JSON.parse(line) as Record<string, unknown>;
    const expected = PATTERN.repeat(Math.ceil(BIG_BYTES / PATTERN.length)).slice(0, BIG_BYTES);
    expect(value).toEqual({
      length: BIG_BYTES,
      textLength: BIG_BYTES,
      head: expected.slice(0, 16),
      middle: expected.slice(1_572_864, 1_572_880),
      tail: expected.slice(-16),
    });
  });
});
