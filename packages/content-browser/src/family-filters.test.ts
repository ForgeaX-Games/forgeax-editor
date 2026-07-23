import { describe, expect, it } from 'bun:test';
import { ALL_FILTER_FAMILIES, FAMILY_FILTER_ICON } from './family-filters';
import type { CBFilterFamily } from './types';

describe('family filters', () => {
  it('exposes a fixed spec-defined family set with dir first and no "other" chip', () => {
    expect(ALL_FILTER_FAMILIES[0]).toBe('dir');
    expect(ALL_FILTER_FAMILIES).not.toContain('other');
    expect(ALL_FILTER_FAMILIES).toEqual([
      'dir', 'scene', 'pack', 'meta', 'model', 'image', 'audio', 'font', 'code', 'config', 'doc', 'data',
    ]);
  });

  it('has no duplicate families', () => {
    expect(new Set(ALL_FILTER_FAMILIES).size).toBe(ALL_FILTER_FAMILIES.length);
  });

  it('maps every family (incl. dir) to a PascalCase lucide glyph', () => {
    const families: CBFilterFamily[] = [
      'dir', 'code', 'config', 'doc', 'scene', 'pack', 'meta', 'image', 'audio', 'model', 'font', 'data', 'other',
    ];
    for (const family of families) {
      expect(FAMILY_FILTER_ICON[family]).toMatch(/^[A-Z]/);
    }
  });
});
