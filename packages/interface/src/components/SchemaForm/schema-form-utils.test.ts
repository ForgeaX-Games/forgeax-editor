/**
 * Phase D2 — pure-helper coverage for SchemaForm.
 * Run: `bun test src/components/SchemaForm/schema-form-utils.test.ts`
 */
import { describe, it, expect } from 'bun:test';
import { defaultFor, findMissingRequired, coerceEnumValue, type JsonSchema } from './schema-form-utils';

describe('SchemaForm utils', () => {
  it('defaultFor returns explicit default when present', () => {
    expect(defaultFor({ type: 'string', default: 'foo' })).toBe('foo');
    expect(defaultFor({ type: 'number', default: 42 })).toBe(42);
  });

  it('defaultFor falls back per type', () => {
    expect(defaultFor({ type: 'string' })).toBe('');
    expect(defaultFor({ type: 'integer' })).toBe(0);
    expect(defaultFor({ type: 'boolean' })).toBe(false);
    expect(defaultFor({ type: 'array' })).toEqual([]);
  });

  it('defaultFor walks object properties', () => {
    const s: JsonSchema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer', default: 18 },
        active: { type: 'boolean' },
      },
    };
    expect(defaultFor(s)).toEqual({ name: '', age: 18, active: false });
  });

  it('findMissingRequired flags empty/undefined required keys', () => {
    const s: JsonSchema = {
      type: 'object',
      required: ['a', 'b'],
      properties: { a: { type: 'string' }, b: { type: 'string' } },
    };
    expect(findMissingRequired(s, {})).toEqual(['a', 'b']);
    expect(findMissingRequired(s, { a: 'x' })).toEqual(['b']);
    expect(findMissingRequired(s, { a: 'x', b: '' })).toEqual(['b']);
    expect(findMissingRequired(s, { a: 'x', b: 'y' })).toEqual([]);
  });

  it('findMissingRequired recurses into nested objects', () => {
    const s: JsonSchema = {
      type: 'object',
      required: ['user'],
      properties: {
        user: {
          type: 'object',
          required: ['name', 'email'],
          properties: { name: { type: 'string' }, email: { type: 'string' } },
        },
      },
    };
    expect(findMissingRequired(s, { user: { name: 'a' } })).toEqual(['user.email']);
    expect(findMissingRequired(s, { user: { name: 'a', email: 'b@x' } })).toEqual([]);
  });

  it('findMissingRequired ignores non-object schemas', () => {
    expect(findMissingRequired({ type: 'string' }, 'hi')).toEqual([]);
  });

  it('coerceEnumValue maps string back to original-typed enum entry', () => {
    expect(coerceEnumValue([1, 2, 3], '2')).toBe(2);
    expect(coerceEnumValue(['a', 'b'], 'b')).toBe('b');
    expect(coerceEnumValue([true, false], 'false')).toBe(false);
  });

  it('coerceEnumValue returns raw string when no match', () => {
    expect(coerceEnumValue([1, 2], '99')).toBe('99');
  });
});
