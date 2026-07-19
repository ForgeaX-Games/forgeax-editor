// packages/interface/src/core/app-shell/host.test.ts
import { describe, expect, it, mock } from 'bun:test';
import { createAppHost } from './host';

describe('createAppHost', () => {
  it('has base capabilities present', () => {
    const { host } = createAppHost();
    expect(host.capabilities.has('commands')).toBe(true);
    expect(host.capabilities.has('bus')).toBe(true);
    expect(host.capabilities.has('storage')).toBe(true);
    expect(host.capabilities.has('panels')).toBe(true);
    expect(host.capabilities.has('contextKeys')).toBe(true);
  });

  it('extend() outside a plugin setup throws', () => {
    const { host } = createAppHost();
    expect(() => host.extend('foo', {})).toThrow(/outside plugin setup/);
  });

  it('extend() inside beginSetup succeeds and adds the capability', () => {
    const { host, control } = createAppHost();
    const manifest = { id: 'p1', version: '1', provides: ['foo'] as const, setup: () => {} };
    control.beginSetup(manifest as any);
    host.extend('foo', { hello: 'world' });
    control.endSetup();
    expect((host as any).foo).toEqual({ hello: 'world' });
    expect(host.capabilities.has('foo')).toBe(true);
  });

  it('removeExtensionsByOwner reverses extends of a given owner', () => {
    const { host, control } = createAppHost();
    const m = { id: 'p1', version: '1', provides: ['a', 'b'] as const, setup: () => {} };
    control.beginSetup(m as any);
    host.extend('a', 1); host.extend('b', 2);
    control.endSetup();
    expect(host.capabilities.has('a')).toBe(true);
    control.removeExtensionsByOwner('p1');
    expect(host.capabilities.has('a')).toBe(false);
    expect(host.capabilities.has('b')).toBe(false);
  });
});
