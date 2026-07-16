import { describe, expect, it } from 'bun:test';
import { mat4, quat } from '@forgeax/engine-math';
import { worldPointToParentLocal } from '../viewport-transform';

const nearVec = (actual: readonly number[], expected: readonly number[]): void => {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) expect(actual[i]!).toBeCloseTo(expected[i]!, 5);
};

describe('worldPointToParentLocal — hierarchy drag write-back', () => {
  it('passes root-world targets through an identity parent transform', () => {
    nearVec(worldPointToParentLocal(mat4.identity(mat4.create()), [7, -2, 4]), [7, -2, 4]);
  });

  it('removes parent translation and rotation from a world drag target', () => {
    const parentWorld = mat4.compose(
      mat4.create(),
      [10, 0, 0],
      quat.fromEuler(quat.create(), 0, 0, Math.PI / 2, 'XYZ'),
      [1, 1, 1],
    );
    // Parent local +Y becomes world -X after the 90° Z rotation.
    nearVec(worldPointToParentLocal(parentWorld, [8, 0, 0]), [0, 2, 0]);
  });

  it('preserves target distance under non-uniform parent scale', () => {
    const parentWorld = mat4.compose(
      mat4.create(),
      [4, 5, 6],
      quat.create(),
      [2, 3, 4],
    );
    nearVec(worldPointToParentLocal(parentWorld, [10, 14, 22]), [3, 3, 4]);
  });
});
