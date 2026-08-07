import { describe, expect, test } from 'bun:test';
import { ResourceSelectorSchema } from './page';

describe('ResourceSelectorSchema', () => {
  test('targeted matchers and the default-editor marker are mutually exclusive', () => {
    expect(ResourceSelectorSchema.safeParse({ kinds: ['mesh'] }).success).toBe(true);
    expect(ResourceSelectorSchema.safeParse({ fallback: true }).success).toBe(true);
    // Both at once would make one entry serve as its own catch-all, which is the
    // shape that let the editor's stale kind list rot unnoticed.
    expect(ResourceSelectorSchema.safeParse({ kinds: ['mesh'], fallback: true }).success).toBe(false);
    expect(ResourceSelectorSchema.safeParse({}).success).toBe(false);
  });
});
