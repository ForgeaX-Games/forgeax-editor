import { describe, expect, it } from 'bun:test';
import { RAIL_CATEGORIES } from './ActivityRail';

describe('ActivityRail categories', () => {
  it('exposes the Asset Canvas workbench in the curated rail', () => {
    const slugs = RAIL_CATEGORIES.flatMap((category) => category.slugs);

    expect(slugs).toContain('wb-asset-canvas');
  });
});
