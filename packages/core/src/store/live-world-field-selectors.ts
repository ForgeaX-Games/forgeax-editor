import {
  normalizeSelectorValue,
  selectorValuesEqual,
  type NormalizedSelectorValue,
  type SelectorValueSchema,
} from './live-world-selectors';
import type { RuntimeUiGraph } from '../io/runtime-ui-diagnostics';

export type InspectorFieldShape =
  | { readonly kind: 'scalar' }
  | { readonly kind: 'tuple' }
  | { readonly kind: 'vector' }
  | { readonly kind: 'color' }
  | { readonly kind: 'quaternion' }
  | { readonly kind: 'array' }
  | { readonly kind: 'typed-array' }
  | { readonly kind: 'pod'; readonly fields?: Readonly<Record<string, SelectorValueSchema>> }
  | { readonly kind: 'unknown'; readonly reason?: string };

export interface InspectorFieldAvailable<T> {
  readonly status: 'available';
  readonly value: T;
  readonly bytes: number;
}

export interface InspectorFieldUnavailable {
  readonly status: 'unavailable';
  readonly code: string;
  readonly hint: string;
  readonly expected: string;
  readonly actual: string;
  readonly retryable: boolean;
}

export type InspectorFieldSnapshot<T> = InspectorFieldAvailable<T> | InspectorFieldUnavailable;

export interface InspectorFieldSelectorOptions<T> {
  readonly entity: number;
  readonly component: string;
  readonly field: string;
  readonly shape: InspectorFieldShape;
  readonly read: (world: unknown, entity: number) => T;
}

export interface InspectorFieldSubscription<T> {
  getSnapshot(): InspectorFieldSnapshot<T> | undefined;
  subscribe(listener: () => void): () => void;
  unsubscribe(): void;
}

export interface InspectorFieldSelector<T> {
  mount(): InspectorFieldSubscription<T>;
}

const unavailableSchema: SelectorValueSchema = { kind: 'pod', fields: {
  status: { kind: 'primitive' },
  code: { kind: 'primitive' },
  hint: { kind: 'primitive' },
  expected: { kind: 'primitive' },
  actual: { kind: 'primitive' },
  retryable: { kind: 'primitive' },
} };

function schemaFor(shape: InspectorFieldShape): SelectorValueSchema {
  switch (shape.kind) {
    case 'scalar': return { kind: 'primitive' };
    case 'tuple':
    case 'vector':
    case 'color':
    case 'quaternion':
    case 'array': return { kind: 'array', item: { kind: 'primitive' } };
    case 'typed-array': return { kind: 'typed-array', item: 'number' };
    case 'pod': return { kind: 'pod', fields: shape.fields ?? {} };
    case 'unknown': return { kind: 'unknown', reason: shape.reason };
  }
}

function unavailable(error: unknown, shape: InspectorFieldShape): InspectorFieldUnavailable {
  const code = shape.kind === 'unknown'
    ? 'selector-value-shape-unsupported'
    : error instanceof Error && error.message.includes('stale')
      ? 'stale-entity-selection'
      : 'selector-read-failed';
  return {
    status: 'unavailable',
    code,
    hint: code === 'stale-entity-selection' ? 'Refresh selection before editing this field.' : 'Retry the field read after the active World is bound.',
    expected: `${shape.kind} Inspector field`,
    actual: error instanceof Error ? error.message : 'unavailable',
    retryable: true,
  };
}

function equalField(left: unknown, right: unknown, schema: SelectorValueSchema): boolean {
  if (isUnavailable(left) || isUnavailable(right)) {
    if (!isUnavailable(left) || !isUnavailable(right)) return false;
    return left.code === right.code && left.actual === right.actual;
  }
  return selectorValuesEqual(left, right, schema);
}

function equalGenericPod(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key) => !Object.hasOwn(rightRecord, key))) return false;
  return leftKeys.every((key) => {
    const a = leftRecord[key];
    const b = rightRecord[key];
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
    return Object.is(a, b);
  });
}

function normalizeFieldValue(value: unknown, shape: InspectorFieldShape, schema: SelectorValueSchema): NormalizedSelectorValue {
  if (shape.kind === 'unknown') return { snapshot: unavailable(new Error(shape.reason ?? 'unknown schema'), shape), bytes: 0 };
  if (shape.kind === 'pod' && Object.keys(shape.fields ?? {}).length === 0) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('pod');
    const source = value as Record<string, unknown>;
    const snapshot: Record<string, unknown> = {};
    let bytes = 0;
    for (const [key, item] of Object.entries(source)) {
      const normalized = ArrayBuffer.isView(item)
        ? Object.freeze(Array.from(item as unknown as ArrayLike<number>))
        : Array.isArray(item)
          ? Object.freeze([...item])
          : item;
      snapshot[key] = normalized;
      bytes += Array.isArray(normalized) ? normalized.length * 8 : typeof normalized === 'number' ? 8 : 0;
    }
    return { snapshot: Object.freeze(snapshot), bytes };
  }
  const input = shape.kind === 'quaternion' && ArrayBuffer.isView(value)
    ? Array.from(value as unknown as ArrayLike<number>)
    : value;
  return normalizeSelectorValue(input, schema);
}

function isUnavailable(value: unknown): value is InspectorFieldUnavailable {
  return typeof value === 'object' && value !== null && (value as { status?: unknown }).status === 'unavailable';
}

export function createInspectorFieldSelector<T>(graph: RuntimeUiGraph, options: InspectorFieldSelectorOptions<T>): InspectorFieldSelector<T> {
  const schema = schemaFor(options.shape);
  const mounted = graph.mount({
    key: `inspector.field.${options.entity}.${options.component}.${options.field}`,
    schema: unavailableSchema,
    read: (world) => {
      try {
        return { status: 'available', value: options.read(world, options.entity) };
      } catch (error) {
        return unavailable(error, options.shape);
      }
    },
    normalize: (result) => {
      if (isUnavailable(result)) return { snapshot: result, bytes: 0 };
      let normalized: NormalizedSelectorValue;
      try {
        normalized = normalizeFieldValue(result.value, options.shape, schema);
      } catch (error) {
        return { snapshot: unavailable(error, options.shape), bytes: 0 };
      }
      if (isUnavailable(normalized.snapshot)) return normalized;
      return { snapshot: { status: 'available', value: normalized.snapshot, bytes: normalized.bytes }, bytes: normalized.bytes };
    },
    equal: (left, right) => {
      if (isUnavailable(left) || isUnavailable(right)) return equalField(left, right, schema);
      const leftValue = (left as { value: unknown }).value;
      const rightValue = (right as { value: unknown }).value;
      if (options.shape.kind === 'pod' && Object.keys(options.shape.fields ?? {}).length === 0) return equalGenericPod(leftValue, rightValue);
      return equalField(leftValue, rightValue, schema);
    },
  });
  return {
    mount: () => {
      let released = false;
      return {
        getSnapshot: () => {
          const snapshot = mounted.getSnapshot() as { status: 'available'; value: unknown; bytes: number } | InspectorFieldUnavailable | undefined;
          if (snapshot === undefined || isUnavailable(snapshot)) return snapshot as InspectorFieldSnapshot<T> | undefined;
          return { status: 'available', value: snapshot.value as T, bytes: snapshot.bytes };
        },
        subscribe: (listener) => mounted.subscribe(listener),
        unsubscribe: () => {
          if (released) return;
          released = true;
          mounted.unsubscribe();
        },
      };
    },
  };
}
