import { describe, expect, it } from 'bun:test';
import { hasMountedPagePlacement } from './DockRegion';

describe('Page layout restore acceptance', () => {
  it('rejects empty or unrelated restored layouts', () => {
    expect(hasMountedPagePlacement(['content'], new Set())).toBe(false);
    expect(hasMountedPagePlacement(['content'], new Set(['tools', 'main']))).toBe(false);
  });

  it('accepts a restore when at least one current Page placement survives', () => {
    expect(hasMountedPagePlacement(['content', 'details'], new Set(['details']))).toBe(true);
  });
});
