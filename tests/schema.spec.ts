import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, ToolDefinitionError } from '../src/index.js';
import { toPlainJson, zodObjectToJsonSchema } from '../src/schema.js';

function searchTool() {
  return defineTool({
    name: 'tool.search',
    version: '1.0.0',
    description: 'Search a corpus.',
    parameters: z.object({
      query: z.string().describe('Search text'),
      limit: z.number().int().min(1).max(10).default(5).optional(),
      tags: z.array(z.enum(['bug', 'docs'])).optional(),
      nested: z.object({ enabled: z.boolean() }),
    }),
    run: async () => ({ ok: true }),
  });
}

describe('schema conversion', () => {
  it('converts a zod 4 object to draft-2020-12 JSON Schema with required fields', () => {
    const parameters = searchTool().manifest.parameters as Record<string, any>;

    expect(parameters.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(parameters.type).toBe('object');
    expect(parameters.required).toEqual(['query', 'nested']);
    expect(parameters.properties.query).toEqual({ type: 'string', description: 'Search text' });
    expect(parameters.properties.limit).toMatchObject({
      type: 'integer',
      default: 5,
      minimum: 1,
      maximum: 10,
    });
    expect(parameters.properties.tags).toMatchObject({
      type: 'array',
      items: { type: 'string', enum: ['bug', 'docs'] },
    });
    expect(parameters.properties.nested).toMatchObject({
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled'],
    });
  });

  it('keeps a default in the manifest while leaving the field optional', () => {
    const tool = defineTool({
      name: 'tool.defaults',
      version: '1.0.0',
      description: 'Schema with a default.',
      parameters: z.object({ retries: z.number().int().default(3) }),
      run: async () => ({ ok: true }),
    });
    const parameters = tool.manifest.parameters as Record<string, any>;

    expect(parameters.properties.retries).toMatchObject({ type: 'integer', default: 3 });
    expect(parameters.required ?? []).not.toContain('retries');
  });

  it('rejects non-object schemas with INVALID_PARAMETERS', () => {
    const build = () =>
      defineTool({
        name: 'tool.bad-parameters',
        version: '1.0.0',
        description: 'Invalid parameters.',
        parameters: z.string() as never,
        run: async () => ({ ok: true }),
      });

    let caught: unknown;
    try {
      build();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ToolDefinitionError);
    expect((caught as ToolDefinitionError).code).toBe('INVALID_PARAMETERS');
  });

  it('inlines everything instead of emitting $ref or $defs', () => {
    const parameters = searchTool().manifest.parameters;
    expect(JSON.stringify(parameters)).not.toContain('$ref');
    expect(JSON.stringify(parameters)).not.toContain('$defs');
  });

  it('is deterministic and plain JSON', () => {
    const first = searchTool().manifest;
    const second = searchTool().manifest;
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(findNonJsonValue(first)).toBeUndefined();
  });

  it('rejects non-object schemas at the schema layer', () => {
    expect(() => zodObjectToJsonSchema(z.string() as never)).toThrow(TypeError);
  });

  it('rejects values that are not JSON-serializable', () => {
    expect(() => toPlainJson({ ok: true, fn: () => 1 }, 'manifest')).toThrow(TypeError);
    expect(() => toPlainJson({ value: Number.NaN }, 'manifest')).toThrow(TypeError);
  });
});

function findNonJsonValue(value: unknown): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : 'non-finite number';
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = findNonJsonValue(item);
      if (problem !== undefined) return problem;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'function') return `function at ${key}`;
      const problem = findNonJsonValue(item);
      if (problem !== undefined) return `${problem} at ${key}`;
    }
    return undefined;
  }
  return typeof value;
}
