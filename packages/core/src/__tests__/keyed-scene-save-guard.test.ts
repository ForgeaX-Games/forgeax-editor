import { expect, test } from 'bun:test';
import { wouldDropAllEntities, stripDisabledMarker } from '../store/persistence/disk-io';

test('keyed scene save guard preserves a nonempty scene and rejects an empty replacement', () => {
  const pack = (entities: unknown) => ({ assets: [{ kind: 'scene', payload: { entities } }] });
  expect(wouldDropAllEntities(1, pack({ root: { components: {} } }))).toBe(false);
  expect(wouldDropAllEntities(1, pack({}))).toBe(true);
  expect(wouldDropAllEntities(1, pack([]))).toBe(true);
});

test('stripping a keyed scene preserves identity and authored fields without mutating the source', () => {
  const source = { kind: 'scene', entities: { root: { components: { Disabled: {}, Name: { value: 'Root' } } } } };
  expect(stripDisabledMarker(source)).toEqual({ kind: 'scene', entities: { root: { components: { Name: { value: 'Root' } } } } });
  expect(source.entities.root.components).toHaveProperty('Disabled');
});
