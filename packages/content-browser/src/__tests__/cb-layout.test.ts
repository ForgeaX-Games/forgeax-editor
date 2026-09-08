// Shallow guard for the asset-view layout persistence contract: any stored value
// must coerce to one of the three UE-parity modes (tiles / list / details), and
// anything unknown/missing falls back to tiles. Pure — no DOM, no React.

import { describe, expect, it } from 'bun:test';
import { parseLayout } from '../hooks/useCBLayout';

describe('parseLayout', () => {
  it('passes through the three valid modes', () => {
    expect(parseLayout('grid')).toBe('grid');
    expect(parseLayout('list')).toBe('list');
    expect(parseLayout('column')).toBe('column');
  });

  it('defaults to tiles (grid) for missing or unknown values', () => {
    expect(parseLayout(null)).toBe('grid');
    expect(parseLayout(undefined)).toBe('grid');
    expect(parseLayout('')).toBe('grid');
    expect(parseLayout('tiles')).toBe('grid');
    expect(parseLayout('COLUMN')).toBe('grid');
  });
});
