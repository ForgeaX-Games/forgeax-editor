import { describe, expect, it } from 'bun:test';
import {
  getAuthoredVersion,
  notifyAuthoredChanged,
  subscribeAuthoredChanges,
} from '../store/doc-version';

describe('producer-owned invalidation adapters', () => {
  it('publishes authored changes without publishing runtime-only churn', () => {
    const seen: number[] = [];
    const off = subscribeAuthoredChanges(() => seen.push(getAuthoredVersion()));
    const before = getAuthoredVersion();

    notifyAuthoredChanged();

    expect(getAuthoredVersion()).toBe(before + 1);
    expect(seen).toEqual([before + 1]);
    off();
  });
});
