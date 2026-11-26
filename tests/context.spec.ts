import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createTestContext,
  defineTool,
  runTool,
  ToolArgumentError,
} from '../src/index.js';
import type { TestCommandCall } from '../src/index.js';

describe('runTool', () => {
  it('rejects invalid arguments without calling run', async () => {
    let received: unknown;
    const tool = defineTool({
      name: 'tool.echo',
      version: '0.1.0',
      description: 'Echo one string.',
      parameters: z.object({ text: z.string().min(1) }),
      run: async (_ctx, args) => {
        received = args;
        return { text: args.text };
      },
    });

    const ctx = createTestContext();
    await expect(runTool(tool, { text: 42 }, ctx)).rejects.toBeInstanceOf(ToolArgumentError);
    expect(received).toBeUndefined();

    const failure = await runTool(tool, {}, ctx).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolArgumentError);
    const argumentError = failure as ToolArgumentError;
    expect(argumentError.tool).toBe('tool.echo');
    expect(argumentError.issues[0]?.path).toEqual(['text']);
    expect(argumentError.message).toContain('invalid arguments for tool.echo');
  });

  it('parses defaults and passes the parsed args to run', async () => {
    let received: unknown;
    const tool = defineTool({
      name: 'tool.defaults',
      version: '0.1.0',
      description: 'Apply a default.',
      parameters: z.object({ times: z.number().int().default(2) }),
      run: async (_ctx, args) => {
        received = args;
        return { times: args.times };
      },
    });

    const result = await runTool(tool, {}, createTestContext());
    expect(result).toEqual({ times: 2 });
    expect(received).toEqual({ times: 2 });
  });
});

describe('createTestContext filesystem', () => {
  it('serves, writes, lists, globs and greps in-memory files', async () => {
    const ctx = createTestContext({
      workspace: '/work',
      files: {
        'src/a.ts': 'TODO one\nconst x = 1;\nTODO two',
        'README.md': '# hi',
      },
    });

    expect(ctx.workspace).toBe('/work');
    expect(await ctx.fs.read('src/a.ts')).toContain('TODO one');
    await ctx.fs.write('/work/src/b.ts', 'TODO three');

    expect(ctx.files()).toEqual({
      'README.md': '# hi',
      'src/a.ts': 'TODO one\nconst x = 1;\nTODO two',
      'src/b.ts': 'TODO three',
    });
    expect(await ctx.fs.list('src')).toEqual([
      { name: 'a.ts', path: 'src/a.ts', kind: 'file' },
      { name: 'b.ts', path: 'src/b.ts', kind: 'file' },
    ]);
    expect(await ctx.fs.glob('**/*.ts')).toEqual(['src/a.ts', 'src/b.ts']);
    expect(await ctx.fs.grep('TODO', { glob: 'src/*.ts' })).toEqual([
      { path: 'src/a.ts', line: 1, text: 'TODO one' },
      { path: 'src/a.ts', line: 3, text: 'TODO two' },
      { path: 'src/b.ts', line: 1, text: 'TODO three' },
    ]);

    expect(ctx.calls.map((call) => call.kind)).toEqual([
      'fs.read',
      'fs.write',
      'fs.list',
      'fs.glob',
      'fs.grep',
    ]);
    expect(ctx.calls[0]).toEqual({ kind: 'fs.read', path: 'src/a.ts' });
    expect(ctx.calls[4]).toMatchObject({ kind: 'fs.grep', pattern: 'TODO', glob: 'src/*.ts' });
  });

  it('derives directories from file paths', async () => {
    const ctx = createTestContext({ files: { 'a/b/c.txt': 'x', 'top.txt': 'y' } });

    expect(await ctx.fs.list('.')).toEqual([
      { name: 'a', path: 'a', kind: 'directory' },
      { name: 'top.txt', path: 'top.txt', kind: 'file' },
    ]);
    expect(await ctx.fs.list('a')).toEqual([
      { name: 'b', path: 'a/b', kind: 'directory' },
    ]);
    expect(await ctx.fs.glob('a/**/c.txt')).toEqual(['a/b/c.txt']);
  });

  it('rejects paths outside the workspace', async () => {
    const ctx = createTestContext({ workspace: '/work', files: {} });

    await expect(ctx.fs.read('../outside.txt')).rejects.toThrow(/escapes the workspace/);
    await expect(ctx.fs.read('sub/../../outside.txt')).rejects.toThrow(/escapes the workspace/);
    await expect(ctx.fs.read('/etc/passwd')).rejects.toThrow(/outside the workspace/);
    await expect(ctx.fs.write('/work/../escape.txt', 'x')).rejects.toThrow(/outside the workspace/);
  });

  it('handles drive-letter workspaces', async () => {
    const ctx = createTestContext({
      workspace: 'C:\\work',
      files: { 'C:\\work\\a.txt': 'hello' },
    });

    expect(await ctx.fs.read('C:/work/a.txt')).toBe('hello');
    expect(await ctx.fs.read('a.txt')).toBe('hello');
    await expect(ctx.fs.read('D:/work/a.txt')).rejects.toThrow(/outside the workspace/);
    await expect(ctx.fs.read('..\\outside.txt')).rejects.toThrow(/escapes the workspace/);
  });

  it('throws clear errors when fs was not enabled', async () => {
    const ctx = createTestContext();

    await expect(ctx.fs.read('a.txt')).rejects.toThrow(/options\.files/);
    await expect(ctx.fs.write('a.txt', 'x')).rejects.toThrow(/options\.files/);
    await expect(ctx.fs.list('.')).rejects.toThrow(/options\.files/);
    await expect(ctx.fs.glob('**/*')).rejects.toThrow(/options\.files/);
    await expect(ctx.fs.grep('x')).rejects.toThrow(/options\.files/);
  });

  it('restores initial files and clears the recorder on reset', async () => {
    const ctx = createTestContext({ files: { 'a.txt': 'one' } });
    await ctx.fs.read('a.txt');
    await ctx.fs.write('b.txt', 'two');

    ctx.reset();

    expect(ctx.calls).toEqual([]);
    expect(ctx.files()).toEqual({ 'a.txt': 'one' });
  });
});

describe('createTestContext process', () => {
  it('records argv-only process calls and uses matching handlers', async () => {
    const seen: TestCommandCall[] = [];
    const ctx = createTestContext({
      commands: [
        {
          argv: ['echo', 'hi'],
          handler: (call) => {
            seen.push(call);
            return { stdout: `${call.argv.join(' ')}\n` };
          },
        },
      ],
    });

    const result = await ctx.process.run({
      argv: ['echo', 'hi'],
      cwd: '/work',
      env: { A: '1' },
      stdin: 'input',
    });

    expect(result).toEqual({ code: 0, stdout: 'echo hi\n', stderr: '' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ argv: ['echo', 'hi'], cwd: '/work', env: { A: '1' }, stdin: 'input' });
    expect(ctx.calls).toEqual([
      { kind: 'process.run', argv: ['echo', 'hi'], cwd: '/work', env: { A: '1' }, stdin: 'input' },
    ]);
  });

  it('rejects empty argv and unhandled commands', async () => {
    const ctx = createTestContext({
      commands: [{ argv: ['echo', 'hi'], handler: () => ({ stdout: 'hi' }) }],
    });

    await expect(ctx.process.run({ argv: [] })).rejects.toThrow(/non-empty argv/);
    await expect(ctx.process.run({ argv: ['echo', 'nope'] })).rejects.toThrow(
      /no test command handler/,
    );
    await expect(ctx.process.run(null as never)).rejects.toThrow(/options object with argv/);
  });

  it('throws a clear error when process was not enabled', async () => {
    const ctx = createTestContext();
    await expect(ctx.process.run({ argv: ['echo', 'hi'] })).rejects.toThrow(/options\.commands/);
  });
});

describe('createTestContext net', () => {
  it('serves handled fetches and records them', async () => {
    const ctx = createTestContext({
      fetches: [
        {
          url: /^https:\/\/api\.example\.com\//,
          handler: (call) => ({
            status: 201,
            headers: { 'content-type': 'text/plain' },
            body: `ok ${call.url}`,
          }),
        },
      ],
    });

    const response = await ctx.net.fetch('https://api.example.com/v1', {
      method: 'GET',
      headers: { accept: 'text/plain' },
    });

    expect(response).toMatchObject({
      ok: true,
      status: 201,
      statusText: '',
      url: 'https://api.example.com/v1',
      headers: { 'content-type': 'text/plain' },
      body: 'ok https://api.example.com/v1',
      text: 'ok https://api.example.com/v1',
    });
    // `json` closes over the body, so a destructured call works.
    const { json } = response;
    expect(() => json()).toThrow();
    expect(ctx.calls[0]).toMatchObject({
      kind: 'net.fetch',
      url: 'https://api.example.com/v1',
      init: { method: 'GET' },
    });
  });

  it('derives ok, text and json() from the handler response', async () => {
    const ctx = createTestContext({
      fetches: [{ url: 'https://api.example.com/json', handler: () => ({ body: '{"n":1}' }) }],
    });

    const response = await ctx.net.fetch('https://api.example.com/json');

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(response.text).toBe('{"n":1}');
    expect(response.json()).toEqual({ n: 1 });

    const missing = createTestContext({
      fetches: [{ url: 'https://api.example.com/missing', handler: () => ({ status: 404 }) }],
    });
    const notFound = await missing.net.fetch('https://api.example.com/missing');
    expect(notFound.ok).toBe(false);
    expect(notFound.body).toBe('');
  });

  it('serves env exactly as passed, frozen', () => {
    const ctx = createTestContext({ env: { EXA_API_KEY: 'secret' } });

    expect(ctx.env.EXA_API_KEY).toBe('secret');
    expect(ctx.env.OTHER).toBeUndefined();
    expect(Object.isFrozen(ctx.env)).toBe(true);
    expect(createTestContext().env).toEqual({});
    expect(() => createTestContext({ env: { X: 1 as never } })).toThrow(/must be a string/);
  });

  it('rejects unhandled hosts, invalid URLs and disabled net', async () => {
    const ctx = createTestContext({
      fetches: [{ url: 'https://api.example.com/v1', handler: () => ({ body: 'ok' }) }],
    });

    await expect(ctx.net.fetch('https://other.example.com/')).rejects.toThrow(
      /no test fetch handler/,
    );
    await expect(ctx.net.fetch('ftp://example.com')).rejects.toThrow(/http\(s\)/);

    const bare = createTestContext();
    await expect(bare.net.fetch('https://example.com')).rejects.toThrow(/options\.fetches/);
  });
});

describe('createTestContext recorder and limits', () => {
  it('records logs and rejects unknown levels', () => {
    const ctx = createTestContext();
    ctx.log('info', 'hello');
    expect(ctx.calls).toContainEqual({ kind: 'log', level: 'info', message: 'hello' });
    expect(() => ctx.log('trace' as never, 'x')).toThrow(/invalid log level/);
  });

  it('honours an aborted signal', async () => {
    const controller = new AbortController();
    const ctx = createTestContext({ files: { 'a.txt': 'x' }, signal: controller.signal });
    controller.abort();
    await expect(ctx.fs.read('a.txt')).rejects.toThrow();
  });

  it('rejects malformed context options early', () => {
    expect(() => createTestContext({ files: { a: 1 as never } })).toThrow(/must be a string/);
    expect(() =>
      createTestContext({ commands: [{ argv: [], handler: () => ({}) }] }),
    ).toThrow(/non-empty argv/);
    expect(() =>
      createTestContext({ fetches: [{ url: 'not-a-url', handler: () => ({}) }] }),
    ).toThrow(/http\(s\)/);
  });
});
