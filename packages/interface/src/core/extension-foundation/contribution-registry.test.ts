// packages/interface/src/core/extension-foundation/contribution-registry.test.ts
import { describe, expect, it } from 'bun:test';
import { createContributionRegistry } from './contribution-registry';

describe('contribution-registry', () => {
  it('preserves contribution order and owner tags', () => {
    const r = createContributionRegistry<string>();
    r.contribute('a', 'one');
    r.contribute('b', 'two');
    r.contribute('a', 'three');
    expect(r.entries().map((e) => `${e.owner}:${e.item}`)).toEqual(['a:one', 'b:two', 'a:three']);
  });

  it('cleanup removes exactly its entry; remaining order intact', () => {
    const r = createContributionRegistry<string>();
    r.contribute('a', 'one');
    const off = r.contribute('b', 'two');
    r.contribute('c', 'three');
    off();
    expect(r.entries().map((e) => e.item)).toEqual(['one', 'three']);
  });

  it('cleanup is idempotent — double-call removes nothing else', () => {
    const r = createContributionRegistry<string>();
    const off = r.contribute('a', 'one');
    r.contribute('a', 'one'); // identical payload, separate entry
    off();
    off();
    expect(r.entries()).toHaveLength(1);
  });

  it('version bumps on every add and remove', () => {
    const r = createContributionRegistry<number>();
    const v0 = r.version();
    const off = r.contribute('a', 1);
    expect(r.version()).toBe(v0 + 1);
    off();
    expect(r.version()).toBe(v0 + 2);
  });

  it('onChange fires on add/remove; unsubscribe stops it', () => {
    const r = createContributionRegistry<number>();
    let fired = 0;
    const unsub = r.onChange(() => { fired++; });
    const off = r.contribute('a', 1);
    off();
    expect(fired).toBe(2);
    unsub();
    r.contribute('a', 2);
    expect(fired).toBe(2);
  });

  it('a listener may unsubscribe itself during notification', () => {
    const r = createContributionRegistry<number>();
    let calls = 0;
    const unsub = r.onChange(() => { calls++; unsub(); });
    r.contribute('a', 1);
    r.contribute('a', 2);
    expect(calls).toBe(1);
  });
});
