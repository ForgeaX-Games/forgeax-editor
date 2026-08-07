import { describe, expect, it } from 'bun:test';

import { validatePerspectiveFov } from '../render-diagnostics';

describe('validatePerspectiveFov', () => {
  it('accepts a finite perspective field of view in radians', () => {
    expect(validatePerspectiveFov(Math.PI / 3)).toBeUndefined();
  });

  it('rejects degree-shaped and otherwise invalid projection inputs', () => {
    expect(validatePerspectiveFov(60)?.code).toBe('render-camera-invalid-projection');
    expect(validatePerspectiveFov(0)?.actual).toBe(0);
    expect(validatePerspectiveFov(Math.PI)?.actual).toBe(Math.PI);
    expect(validatePerspectiveFov(Number.NaN)?.actual).toBe(Number.NaN);
    expect(validatePerspectiveFov(Number.POSITIVE_INFINITY)?.actual).toBe(Number.POSITIVE_INFINITY);
  });
});
