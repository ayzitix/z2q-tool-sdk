import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, ToolDefinitionError } from '../src/index.js';
import type { Capabilities, DefineToolOptions } from '../src/index.js';

function validOptions(): DefineToolOptions<{ text: z.ZodString }> {
  return {
    name: 'tool.echo',
    version: '0.1.0',
    description: 'Echo the input back.',
    parameters: z.object({ text: z.string() }),
    capabilities: {},
    run: async (_ctx, args) => ({ text: args.text }),
  };
}

function expectDefinitionError(fn: () => unknown, code: string): ToolDefinitionError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolDefinitionError);
    const definitionError = error as ToolDefinitionError;
    expect(definitionError.name).toBe('ToolDefinitionError');
    expect(definitionError.code).toBe(code);
    return definitionError;
  }
  throw new Error(`expected ToolDefinitionError with code ${code}`);
}

describe('defineTool', () => {
  it('builds a deterministic plain-JSON manifest with capability defaults', () => {
    const tool = defineTool(validOptions());

    expect(tool.manifest).toEqual({
      schemaVersion: 1,
      name: 'tool.echo',
      version: '0.1.0',
      description: 'Echo the input back.',
      parameters: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      capabilities: {
        fs: { read: [], write: [] },
        process: { argv: [] },
        net: { hosts: [] },
        limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576 },
      },
    });
    expect(tool.parameters).toBeInstanceOf(z.ZodObject);
    expect(JSON.parse(JSON.stringify(tool.manifest))).toEqual(tool.manifest);
  });

  it('does not call run while defining', () => {
    let calls = 0;
    defineTool({
      ...validOptions(),
      run: async () => {
        calls += 1;
        return {};
      },
    });
    expect(calls).toBe(0);
  });

  it('accepts documented and plain names, and trims the description', () => {
    for (const name of ['tool.echo', 'echo', 'tool.echo-v2', 'a1b']) {
      const tool = defineTool({ ...validOptions(), name, description: '  padded  ' });
      expect(tool.manifest.name).toBe(name);
      expect(tool.manifest.description).toBe('padded');
    }
  });

  it('accepts strict semver including prerelease and build metadata', () => {
    for (const version of ['0.0.0', '1.2.3', '1.0.0-beta.1', '1.0.0-beta.1+build.5']) {
      expect(defineTool({ ...validOptions(), version }).manifest.version).toBe(version);
    }
  });

  it('normalizes, sorts and de-duplicates capabilities', () => {
    const tool = defineTool({
      ...validOptions(),
      capabilities: {
        fs: { read: ['b/**', 'a/**', 'a/**'], write: ['out/**'] },
        process: { argv: ['adb', 'adb'] },
        net: { hosts: ['example.com'] },
      },
    });

    expect(tool.manifest.capabilities).toEqual({
      fs: { read: ['a/**', 'b/**'], write: ['out/**'] },
      process: { argv: ['adb'] },
      net: { hosts: ['example.com'] },
      limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576 },
    });
  });

  it('freezes the manifest', () => {
    const tool = defineTool(validOptions());
    expect(Object.isFrozen(tool.manifest)).toBe(true);
    expect(Object.isFrozen(tool.manifest.capabilities)).toBe(true);
    expect(Object.isFrozen(tool.manifest.capabilities.fs.read)).toBe(true);
    expect(Object.isFrozen(tool.manifest.parameters)).toBe(true);
  });

  it('produces the same manifest for the same definition', () => {
    const first = defineTool(validOptions());
    const second = defineTool(validOptions());
    expect(JSON.stringify(first.manifest)).toBe(JSON.stringify(second.manifest));
  });

  it.each(['ab', 'Tool.Echo', 'tool..echo', 'tool.', '.tool', 'tool echo', '1tool', 'a'.repeat(65)])(
    'rejects invalid name %j',
    (name) => {
      expectDefinitionError(() => defineTool({ ...validOptions(), name }), 'INVALID_NAME');
    },
  );

  it.each(['1', '1.0', 'v1.0.0', '01.0.0', '1.0.0.0', '1.0.0-', '1.0.0+', ''])(
    'rejects invalid version %j',
    (version) => {
      expectDefinitionError(() => defineTool({ ...validOptions(), version }), 'INVALID_VERSION');
    },
  );

  it.each(['', '   ', 'x'.repeat(501)])('rejects invalid description %j', (description) => {
    expectDefinitionError(() => defineTool({ ...validOptions(), description }), 'INVALID_DESCRIPTION');
  });

  it('rejects non-object parameters', () => {
    const parameters = z.string() as unknown as DefineToolOptions<{ text: z.ZodString }>['parameters'];
    expectDefinitionError(() => defineTool({ ...validOptions(), parameters }), 'INVALID_PARAMETERS');
  });

  it('rejects a missing run function', () => {
    const run = undefined as unknown as DefineToolOptions<{ text: z.ZodString }>['run'];
    expectDefinitionError(() => defineTool({ ...validOptions(), run }), 'INVALID_RUN');
  });

  it('rejects a non-object definition', () => {
    expectDefinitionError(() => defineTool(null as never), 'INVALID_DEFINITION');
  });

  it.each<[string, unknown]>([
    ['negative timeout', { limits: { timeoutMs: -1 } }],
    ['zero timeout', { limits: { timeoutMs: 0 } }],
    ['fractional timeout', { limits: { timeoutMs: 1.5 } }],
    ['string timeout', { limits: { timeoutMs: '1000' } }],
    ['negative output limit', { limits: { maxOutputBytes: -1 } }],
    ['non-array fs.read', { fs: { read: '**/*' } }],
    ['unknown fs key', { fs: { execute: ['x'] } }],
    ['non-array process.argv', { process: { argv: 'adb' } }],
    ['non-string host', { net: { hosts: [42] } }],
    ['unknown capability', { shell: true }],
    ['array capabilities', []],
  ])('rejects invalid capabilities: %s', (_label, capabilities) => {
    expectDefinitionError(
      () => defineTool({ ...validOptions(), capabilities: capabilities as Capabilities }),
      'INVALID_CAPABILITIES',
    );
  });

  it('rejects empty capability list entries', () => {
    expectDefinitionError(
      () => defineTool({ ...validOptions(), capabilities: { fs: { read: [''] } } }),
      'INVALID_CAPABILITIES',
    );
  });
});
