import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTool } from '../src/build.js';
import { formatSourceIssues, reviewToolSource, verifyToolSource } from '../src/creator/review.js';
import { readToolDefinition } from '../src/runtime/definition.js';
import { cleanupTempDirs, relativeSpecifier, repoRoot, tempDir } from './runtime-helpers.js';

async function markerExists(marker: string): Promise<boolean> {
  return (await stat(marker).catch(() => undefined)) !== undefined;
}

afterAll(async () => {
  await cleanupTempDirs();
  delete process.env.Z1_HOST_ISOLATION_CANARY;
});

import { CANARY, EXFILTRATION, FAMILIES, hostileSource } from './hostile-families.js';

beforeAll(() => {
  process.env.Z1_HOST_ISOLATION_CANARY = CANARY;
});

describe('host isolation: the 18 source families', () => {
  for (const family of FAMILIES) {
    it(family.name, async () => {
      const dir = await tempDir('z1-host-family-');
      const marker = join(dir, 'marker.txt');
      const source = hostileSource(marker, family.payload(marker));

      const review = reviewToolSource(source);
      expect(review.ok, formatSourceIssues(review.issues)).toBe(true);

      const verified = await verifyToolSource(source);
      expect(verified.ok, formatSourceIssues(verified.issues)).toBe(true);
      expect(await markerExists(marker)).toBe(false);
      expect(process.env.Z1_HOST_ISOLATION_CANARY).toBe(CANARY);
      expect(({} as Record<string, unknown>).z1Polluted).toBeUndefined();
    });
  }

  it('installs no bridge globals in the definition runtime', async () => {
    const dir = await tempDir('z1-host-no-bridge-');
    const marker = join(dir, 'marker.txt');
    const source = hostileSource(
      marker,
      `if (typeof __z1_invoke !== 'undefined' || typeof __z1_args !== 'undefined' || typeof __z1_workspace !== 'undefined') {
  ${EXFILTRATION("({}).constructor.constructor('return process')()", marker)}
}`,
    );

    const verified = await verifyToolSource(source);
    expect(verified.ok, formatSourceIssues(verified.issues)).toBe(true);
    expect(await markerExists(marker)).toBe(false);
  });

  it('plain top-level process.exit(7) cannot kill the builder', async () => {
    const dir = await tempDir('z1-host-exit-');
    const marker = join(dir, 'marker.txt');
    const manifest = {
      schemaVersion: 1,
      name: 'tool.host-exit',
      version: '0.1.0',
      description: 'A source that exits the host if its top level ever runs there.',
      parameters: { type: 'object', properties: {} },
      capabilities: {
        fs: { read: [], write: [] },
        process: { argv: [] },
        net: { hosts: [] },
        limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576 },
      },
    };
    const source = `export const tool = { manifest: ${JSON.stringify(manifest)}, run: async () => ({ ok: true }) };
process.exit(7);
`;
    await writeFile(join(dir, 'tool.ts'), source, 'utf8');

    const result = await runCli(['build', dir]);
    expect(result.code).not.toBe(7);
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('process');
    expect(await markerExists(marker)).toBe(false);
  });

  it('caps a multi-megabyte thrown value before it crosses to the host', async () => {
    const bundle = (payload: string): string =>
      `${payload}\nexport const tool = { manifest: { schemaVersion: 1, name: 'tool.huge', version: '0.1.0', description: 'A fixture for the definition reader.', parameters: { type: 'object', properties: {} }, capabilities: { fs: { read: [], write: [] }, process: { argv: [] }, net: { hosts: [] }, limits: { timeoutMs: 30000, maxOutputBytes: 1048576 } } }, run: async () => ({}) };\n`;

    const message = await readToolDefinition(bundle("throw 'x'.repeat(1024 * 1024);")).then(
      () => 'no error',
      (error: Error) => error.message,
    );
    // The VM caps at 4 KiB, so the 1 MiB string never crosses; `oneLine` keeps
    // the first line and appends an ellipsis.
    expect(message.length).toBeGreaterThan(4_000);
    expect(message.length).toBeLessThan(4_200);

    const second = await readToolDefinition(bundle('void 0;'));
    expect((second.manifest as { name: string }).name).toBe('tool.huge');
  });

  it('prints no QuickJS teardown abort for a bundle that throws 8 MiB', async () => {
    const dir = await tempDir('z1-host-huge-throw-cli-');
    const file = join(dir, 'tool.ts');
    await writeFile(
      file,
      [
        "import { defineTool } from 'z1-tool-sdk';",
        "import { z } from 'zod';",
        "throw 'x'.repeat(8 * 1024 * 1024);",
        'export const tool = defineTool({',
        "  name: 'tool.huge-throw',",
        "  version: '0.1.0',",
        "  description: 'A fixture whose top level throws an eight megabyte string.',",
        '  parameters: z.object({}),',
        '  capabilities: {},',
        '  run: async () => ({}),',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await runCli(['review', file]);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain('Aborted(');
    expect(result.stderr + result.stdout).toContain('build_failed');
  });

  it('leaves Object.prototype clean and lets a second build run', async () => {
    const first = await tempDir('z1-host-pollute-first-');
    const marker = join(first, 'marker.txt');
    const polluted = hostileSource(
      marker,
      'Promise.resolve().then(() => { Object.prototype.z1Polluted = true; });',
    );
    const before = await verifyToolSource(polluted);
    expect(before.ok, formatSourceIssues(before.issues)).toBe(true);
    expect(({} as Record<string, unknown>).z1Polluted).toBeUndefined();

    const second = await tempDir('z1-host-pollute-second-');
    const clean = hostileSource(join(second, 'marker.txt'), 'void 0;');
    const after = await verifyToolSource(clean);
    expect(after.ok, formatSourceIssues(after.issues)).toBe(true);
    expect(({} as Record<string, unknown>).z1Polluted).toBeUndefined();
  });
});

const FIND_TODOS_MANIFEST = `{
  "schemaVersion": 1,
  "name": "tool.find-todos",
  "version": "0.1.0",
  "description": "Find TODO and FIXME comments in workspace files and return their paths and line numbers.",
  "parameters": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "glob": {
        "default": "**/*",
        "description": "Workspace-relative glob of files to scan.",
        "type": "string"
      },
      "limit": {
        "default": 50,
        "description": "Maximum number of matches.",
        "type": "integer",
        "exclusiveMinimum": 0,
        "maximum": 500
      }
    }
  },
  "capabilities": {
    "fs": {
      "read": [
        "**/*"
      ],
      "write": []
    },
    "process": {
      "argv": []
    },
    "net": {
      "hosts": []
    },
    "env": {
      "read": []
    },
    "limits": {
      "timeoutMs": 10000,
      "maxOutputBytes": 262144
    }
  }
}
`;

describe('the definition boundary', () => {
  it('still writes the find-todos manifest byte for byte', async () => {
    const out = await tempDir('z1-host-golden-');
    const result = await buildTool({
      entry: join(repoRoot, 'examples', 'find-todos', 'tool.ts'),
      outDir: join(out, 'dist'),
    });

    const onDisk = await readFile(result.manifestPath, 'utf8');
    expect(onDisk).toBe(FIND_TODOS_MANIFEST);
    expect(JSON.parse(onDisk)).toEqual(result.manifest);
  });

  it('reads a ~1 MB manifest without a teardown abort', async () => {
    const note = 'x'.repeat(900_000);
    const manifest = {
      schemaVersion: 1,
      name: 'tool.large-manifest',
      version: '0.1.0',
      description: 'A large but valid manifest for the definition reader.',
      parameters: { type: 'object', properties: {} },
      capabilities: {
        fs: { read: [], write: [] },
        process: { argv: [] },
        net: { hosts: [] },
        limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576 },
      },
      note,
    };
    const source = `export const tool = { manifest: ${JSON.stringify(manifest)}, run: async () => ({}) };\n`;
    const result = await readToolDefinition(source);
    const read = result.manifest as { note?: string };
    expect(read.note).toHaveLength(note.length);
    const bytes = Buffer.byteLength(JSON.stringify(result.manifest), 'utf8');
    expect(bytes).toBeGreaterThan(900_000);
    expect(bytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('refuses an over-cap manifest inside the VM and stays usable', async () => {
    const manifest = {
      schemaVersion: 1,
      name: 'tool.too-large-manifest',
      version: '0.1.0',
      description: 'A manifest over the mandatory one mebibyte ceiling.',
      note: 'x'.repeat(1_100_000),
    };
    const source = `export const tool = { manifest: ${JSON.stringify(manifest)}, run: async () => ({}) };\n`;

    await expect(readToolDefinition(source)).rejects.toThrow(/manifest_too_large/);

    const small = `export const tool = { manifest: { ok: true }, run: async () => ({}) };\n`;
    await expect(readToolDefinition(small)).resolves.toEqual({ manifest: { ok: true } });
  });

  it('stops a busy loop at the definition budget', async () => {
    const manifest = {
      schemaVersion: 1,
      name: 'tool.busy',
      version: '0.1.0',
      description: 'A bundle that never reaches its manifest.',
      parameters: { type: 'object', properties: {} },
      capabilities: {
        fs: { read: [], write: [] },
        process: { argv: [] },
        net: { hosts: [] },
        limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576 },
      },
    };
    const source = `while (true) {}
export const tool = { manifest: ${JSON.stringify(manifest)}, run: async () => ({}) };
`;

    await expect(readToolDefinition(source, { timeoutMs: 100 })).rejects.toThrow(
      /definition budget|interrupted/i,
    );
  });

  it('refuses a static import with one clear message', async () => {
    const dir = await tempDir('z1-host-static-import-');
    const sdk = relativeSpecifier(dir, join(repoRoot, 'src', 'index.ts'));
    await writeFile(
      join(dir, 'tool.ts'),
      `import { defineTool } from ${JSON.stringify(sdk)};
import { z } from 'zod';
export const tool = defineTool({
  name: 'tool.static-import',
  version: '0.1.0',
  description: 'A bundle that keeps a static zod import.',
  parameters: z.object({}),
  capabilities: {},
  run: async () => ({ ok: true }),
});
`,
      'utf8',
    );

    await expect(
      buildTool({
        entry: join(dir, 'tool.ts'),
        outDir: join(dir, 'dist'),
        external: ['zod'],
        aliases: { 'z1-tool-sdk': join(repoRoot, 'src', 'index.ts') },
      }),
    ).rejects.toThrow(
      'the bundle has a static import that the sandbox cannot resolve — bundle everything',
    );
  });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(repoRoot, 'src', 'cli.ts'), ...args], {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', rejectPromise);
    child.once('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}
