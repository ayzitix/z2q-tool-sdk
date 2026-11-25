import { z } from 'zod';
import type { Json, JsonObject } from './types.js';

/**
 * Structural check that tolerates two zod copies in one process.
 *
 * zod 4 exposes the schema kind at `_zod.def.type`; `instanceof z.ZodObject`
 * alone fails when a tool and the SDK resolve different zod installations.
 */
export function isZodObject(value: unknown): value is z.ZodObject<z.ZodRawShape> {
  if (typeof value !== 'object' || value === null) return false;
  const def = (value as { _zod?: { def?: { type?: unknown } } })._zod?.def;
  if (typeof def === 'object' && def !== null && def.type === 'object') {
    return true;
  }
  return value instanceof z.ZodObject;
}

/**
 * Convert a zod 4 object schema to draft-2020-12 JSON Schema.
 *
 * `io: 'input'` describes what the tool accepts: fields with defaults stay
 * optional and keep their `default`, which is the right contract for tool
 * arguments. The result is a single plain-JSON document with no functions.
 */
export function zodObjectToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): JsonObject {
  if (!isZodObject(schema)) {
    throw new TypeError('parameters must be a zod 4 object schema created with z.object({...})');
  }
  const raw = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
  });
  return toPlainJson(raw, 'parameters') as JsonObject;
}

/** Assert a value is plain JSON and return a fresh copy of it. */
export function toPlainJson(value: unknown, path = 'manifest'): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} contains a non-finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => toPlainJson(item, `${path}[${index}]`));
  }
  if (typeof value === 'object') {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = toPlainJson(item, `${path}.${key}`);
    }
    return out;
  }
  throw new TypeError(`${path} is not JSON-serializable (${typeof value})`);
}
