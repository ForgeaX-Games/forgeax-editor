/**
 * Phase D2 — SchemaForm pure helpers.
 *
 * Extracted so they can be unit-tested without a React/DOM runtime. The .tsx
 * component imports `defaultFor` + `findMissingRequired` from here.
 */

export type JsonSchema = {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
  title?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  'x-fx-readonly'?: boolean;
  'x-fx-secret'?: boolean;
  'x-fx-multiline'?: boolean;
};

export function defaultFor(schema: JsonSchema): unknown {
  if (schema.default !== undefined) return schema.default;
  switch (schema.type) {
    case 'string': return '';
    case 'number':
    case 'integer': return 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': {
      const o: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(schema.properties ?? {})) {
        o[k] = defaultFor(sub);
      }
      return o;
    }
    default: return null;
  }
}

/** Walk a value vs schema and return the list of missing required leaves
 *  (dotted paths, e.g. `["user.name", "user.email"]`). Empty string + null
 *  + undefined all count as missing. */
export function findMissingRequired(schema: JsonSchema, value: unknown, path: string[] = []): string[] {
  if (schema.type !== 'object' || !schema.required) return [];
  const missing: string[] = [];
  const obj = (value && typeof value === 'object') ? (value as Record<string, unknown>) : {};
  for (const k of schema.required) {
    const sub = schema.properties?.[k];
    const v = obj[k];
    if (v === undefined || v === null || v === '') {
      missing.push([...path, k].join('.'));
    } else if (sub) {
      missing.push(...findMissingRequired(sub, v, [...path, k]));
    }
  }
  return missing;
}

export function coerceEnumValue(opts: unknown[], raw: string): unknown {
  for (const opt of opts) if (String(opt) === raw) return opt;
  return raw;
}
