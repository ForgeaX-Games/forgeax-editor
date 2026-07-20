// packages/interface/src/core/extension-foundation/capabilities.test.ts
import { describe, expect, it, mock } from 'bun:test';
import { createCapabilityRegistry } from './capabilities';

describe('CapabilityRegistry', () => {
  it('add is idempotent; has reports membership', () => {
    const reg = createCapabilityRegistry<'a' | 'b'>();
    reg.add('a');
    reg.add('a');
    expect(reg.has('a')).toBe(true);
    expect(reg.has('b')).toBe(false);
  });

  it('added event fires once per unique add', () => {
    const reg = createCapabilityRegistry<'a'>();
    const listener = mock((_c: 'a') => {});
    reg.on('added', listener);
    reg.add('a');
    reg.add('a');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('remove fires removed event; second remove is no-op', () => {
    const reg = createCapabilityRegistry<'a'>();
    const listener = mock((_c: 'a') => {});
    reg.on('removed', listener);
    reg.add('a');
    reg.remove('a');
    reg.remove('a');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('snapshot returns a frozen set (mutation throws)', () => {
    const reg = createCapabilityRegistry<'a'>();
    reg.add('a');
    const snap = reg.snapshot();
    expect(() => (snap as Set<'a'>).add('a')).toThrow();
  });
});
