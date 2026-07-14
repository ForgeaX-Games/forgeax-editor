// packages/interface/src/core/extension-foundation/context-keys.test.ts
import { describe, expect, it, mock } from 'bun:test';
import { createContextKeys } from './context-keys';

describe('ContextKeys', () => {
  it('get returns undefined for unknown key', () => {
    const ck = createContextKeys();
    expect(ck.get('nope')).toBeUndefined();
  });

  it('set stores value; get reads it back', () => {
    const ck = createContextKeys();
    ck.set('mode', 'ai');
    expect(ck.get('mode')).toBe('ai');
  });

  it('onChange fires when value changes but not when equal', () => {
    const ck = createContextKeys();
    ck.set('mode', 'ai');
    const listener = mock((_v: unknown) => {});
    ck.onChange('mode', listener);
    ck.set('mode', 'ai');  // no-op
    ck.set('mode', 'scene');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('scene');
  });

  it('onChange cleanup stops delivery', () => {
    const ck = createContextKeys();
    const listener = mock((_v: unknown) => {});
    const off = ck.onChange('m', listener);
    off();
    ck.set('m', 1);
    expect(listener).not.toHaveBeenCalled();
  });
});
