// packages/interface/src/core/app-shell/react/HostProvider.test.tsx
import { describe, expect, it } from 'bun:test';
import React from 'react';
import { render, act } from '@testing-library/react';
import { createAppHost } from '../host';
import { HostProvider, useHost, useCommand, useContextKey } from './HostProvider';

describe('HostProvider', () => {
  it('useHost throws outside provider', () => {
    const Bad = () => { useHost(); return null; };
    expect(() => render(<Bad />)).toThrow(/outside <HostProvider>/);
  });

  it('useCommand invokes host.commands.execute with args', async () => {
    const { host } = createAppHost();
    let called: unknown;
    host.commands.register({ id: 'x', execute: (a) => { called = a; return 'ok'; } });
    const Comp = () => {
      const run = useCommand<{ n: number }, string>('x');
      React.useEffect(() => { run({ n: 42 }); }, [run]);
      return null;
    };
    render(<HostProvider value={host}><Comp /></HostProvider>);
    await new Promise((r) => setTimeout(r, 0));
    expect(called).toEqual({ n: 42 });
  });

  it('useContextKey re-renders on change', async () => {
    const { host } = createAppHost();
    host.contextKeys.set('m', 'ai');
    let seen: string | undefined;
    const Comp = () => { seen = useContextKey<string>('m'); return null; };
    render(<HostProvider value={host}><Comp /></HostProvider>);
    expect(seen).toBe('ai');
    await act(async () => { host.contextKeys.set('m', 'scene'); });
    expect(seen).toBe('scene');
  });
});
