import { describe, expect, it } from 'bun:test';
import { isSlotDebugEnabled } from './isSlotDebugEnabled';

describe('isSlotDebugEnabled', () => {
  it('returns true for ?debug=slots', () => {
    expect(isSlotDebugEnabled('?debug=slots')).toBe(true);
  });

  it('returns true when slots is one of several comma flags', () => {
    expect(isSlotDebugEnabled('?debug=slots,other')).toBe(true);
    expect(isSlotDebugEnabled('?debug=other,slots')).toBe(true);
    expect(isSlotDebugEnabled('?foo=1&debug=other,slots')).toBe(true);
  });

  it('returns false for missing/unrelated query', () => {
    expect(isSlotDebugEnabled('')).toBe(false);
    expect(isSlotDebugEnabled('?debug=other')).toBe(false);
    expect(isSlotDebugEnabled('?bugs=slots')).toBe(false);
    expect(isSlotDebugEnabled('?debug=')).toBe(false);
  });

  it('trims whitespace around flag tokens', () => {
    expect(isSlotDebugEnabled('?debug=other, slots')).toBe(true);
    expect(isSlotDebugEnabled('?debug= slots ')).toBe(true);
  });

  it('never throws — malformed input returns false', () => {
    expect(() => isSlotDebugEnabled('%%%invalid%%%')).not.toThrow();
    expect(isSlotDebugEnabled('%%%invalid%%%')).toBe(false);
  });
});
