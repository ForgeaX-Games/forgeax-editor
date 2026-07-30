/**
 * Producer-owned selector value shapes. The normalizer deliberately accepts a
 * small closed set so an unsupported shape becomes a recoverable error rather
 * than an accidental deep clone or JSON mirror.
 */
export type SelectorValueSchema =
  | { readonly kind: 'primitive' }
  | { readonly kind: 'tuple'; readonly items: readonly SelectorValueSchema[] }
  | { readonly kind: 'array'; readonly item: SelectorValueSchema }
  | { readonly kind: 'typed-array'; readonly item: 'number' | 'bigint' }
  | { readonly kind: 'pod'; readonly fields: Readonly<Record<string, SelectorValueSchema>> }
  | { readonly kind: 'unknown'; readonly reason?: string };

export interface NormalizedSelectorValue {
  readonly snapshot: unknown;
  readonly bytes: number;
}

export class SelectorValueShapeUnsupportedError extends Error {
  readonly code = 'selector-value-shape-unsupported' as const;

  constructor(kind: string) {
    super(`selector-value-shape-unsupported: ${kind}`);
    this.name = 'SelectorValueShapeUnsupportedError';
  }
}

function isTypedArray(value: unknown): value is ArrayBufferView & { readonly length: number; readonly [index: number]: number | bigint } {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function primitiveBytes(value: unknown): number {
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'number') return 8;
  if (typeof value === 'bigint') return 8;
  if (typeof value === 'string') return value.length * 2;
  return 0;
}

function normalize(value: unknown, schema: SelectorValueSchema): NormalizedSelectorValue {
  switch (schema.kind) {
    case 'primitive':
      if (value !== null && typeof value === 'object') {
        throw new SelectorValueShapeUnsupportedError('primitive-object');
      }
      return { snapshot: value, bytes: primitiveBytes(value) };
    case 'tuple': {
      if (!Array.isArray(value) || value.length !== schema.items.length) {
        throw new SelectorValueShapeUnsupportedError('tuple');
      }
      const items = schema.items.map((item, index) => normalize(value[index], item));
      return { snapshot: Object.freeze(items.map((item) => item.snapshot)), bytes: items.reduce((sum, item) => sum + item.bytes, 0) };
    }
    case 'array': {
      if (!Array.isArray(value)) throw new SelectorValueShapeUnsupportedError('array');
      const items = value.map((item) => normalize(item, schema.item));
      return { snapshot: Object.freeze(items.map((item) => item.snapshot)), bytes: items.reduce((sum, item) => sum + item.bytes, 0) };
    }
    case 'typed-array': {
      if (!isTypedArray(value)) throw new SelectorValueShapeUnsupportedError('typed-array');
      const snapshot = Array.from(value);
      if (schema.item === 'number' && snapshot.some((item) => typeof item !== 'number')) {
        throw new SelectorValueShapeUnsupportedError('typed-array-number');
      }
      if (schema.item === 'bigint' && snapshot.some((item) => typeof item !== 'bigint')) {
        throw new SelectorValueShapeUnsupportedError('typed-array-bigint');
      }
      return { snapshot: Object.freeze(snapshot), bytes: snapshot.length * 8 };
    }
    case 'pod': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new SelectorValueShapeUnsupportedError('pod');
      }
      const source = value as Record<string, unknown>;
      const snapshot: Record<string, unknown> = {};
      let bytes = 0;
      for (const [key, fieldSchema] of Object.entries(schema.fields)) {
        const field = normalize(source[key], fieldSchema);
        snapshot[key] = field.snapshot;
        bytes += field.bytes;
      }
      return { snapshot: Object.freeze(snapshot), bytes };
    }
    case 'unknown':
      throw new SelectorValueShapeUnsupportedError(schema.reason ?? 'unknown');
  }
}

export function normalizeSelectorValue(value: unknown, schema: SelectorValueSchema): NormalizedSelectorValue {
  return normalize(value, schema);
}

export function selectorValuesEqual(left: unknown, right: unknown, schema: SelectorValueSchema): boolean {
  switch (schema.kind) {
    case 'primitive':
      return Object.is(left, right);
    case 'tuple':
      return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => selectorValuesEqual(item, right[index], schema.items[index]!));
    case 'array':
      return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => selectorValuesEqual(item, right[index], schema.item));
    case 'typed-array':
      return isTypedArray(left) && isTypedArray(right) && left.length === right.length && Array.from(left).every((item, index) => Object.is(item, Array.from(right)[index]));
    case 'pod':
      return typeof left === 'object' && left !== null && typeof right === 'object' && right !== null && Object.entries(schema.fields).every(([key, field]) => selectorValuesEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], field));
    case 'unknown':
      throw new SelectorValueShapeUnsupportedError(schema.reason ?? 'unknown');
  }
}
