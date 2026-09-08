import { describe, expect, test } from 'bun:test';
import {
  EDIT_VIEWPORT_MAX_PIXEL_RATIO,
  resolveEditViewportPixelRatio,
} from '../edit-viewport-resolution';

describe('Edit viewport resolution policy', () => {
  test('keeps the Edit viewport at native resolution or above', () => {
    expect(EDIT_VIEWPORT_MAX_PIXEL_RATIO).toBe(1);
    expect(resolveEditViewportPixelRatio(2)).toBe(1);
    expect(resolveEditViewportPixelRatio(1)).toBe(1);
  });

  test('rejects invalid browser ratios without shrinking below one', () => {
    expect(resolveEditViewportPixelRatio(0)).toBe(1);
    expect(resolveEditViewportPixelRatio(Number.NaN)).toBe(1);
  });
});
