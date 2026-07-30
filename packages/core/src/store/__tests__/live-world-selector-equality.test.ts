import { describe, expect, it } from 'bun:test';
import {
  normalizeSelectorValue,
  selectorValuesEqual,
  type SelectorValueSchema,
} from '../live-world-selectors';

const primitive: SelectorValueSchema = { kind: 'primitive' };
const tuple: SelectorValueSchema = { kind: 'tuple', items: [{ kind: 'primitive' }, { kind: 'primitive' }] };
const array: SelectorValueSchema = { kind: 'array', item: { kind: 'primitive' } };
const bytes: SelectorValueSchema = { kind: 'typed-array', item: 'number' };
const pod: SelectorValueSchema = {
  kind: 'pod',
  fields: { x: { kind: 'primitive' }, y: { kind: 'primitive' } },
};

describe('live world selector equality truth table', () => {
  it.each([
    ['NaN remains equal', Number.NaN, Number.NaN, true],
    ['negative zero differs from zero', -0, 0, false],
    ['primitive values compare with Object.is', 'a', 'a', true],
  ])('%s', (_label, left, right, expected) => {
    expect(selectorValuesEqual(left, right, primitive)).toBe(expected);
  });

  it('compares fixed tuples and arrays item by item', () => {
    expect(selectorValuesEqual([1, 'a'], [1, 'a'], tuple)).toBe(true);
    expect(selectorValuesEqual([1, 'a'], [1, 'b'], tuple)).toBe(false);
    expect(selectorValuesEqual([1], [1, 2], array)).toBe(false);
  });

  it('captures in-place TypedArray and POD mutation in immutable snapshots', () => {
    const view = new Float32Array([1, 2]);
    const first = normalizeSelectorValue(view, bytes);
    view[0] = 4;
    const second = normalizeSelectorValue(view, bytes);
    expect(selectorValuesEqual(first.snapshot, second.snapshot, bytes)).toBe(false);

    const value = { x: 1, y: 2 };
    const podFirst = normalizeSelectorValue(value, pod);
    value.x = 3;
    const podSecond = normalizeSelectorValue(value, pod);
    expect(selectorValuesEqual(podFirst.snapshot, podSecond.snapshot, pod)).toBe(false);
  });

  it('rejects unknown schemas without inventing deep equality', () => {
    expect(() => normalizeSelectorValue({ x: 1 }, { kind: 'unknown' })).toThrow('selector-value-shape-unsupported');
  });

  it('reports stable snapshot identity and bounded byte estimates', () => {
    const value = normalizeSelectorValue([1, 2], array);
    expect(value.snapshot).toBe(value.snapshot);
    expect(value.bytes).toBeGreaterThan(0);
  });
});
