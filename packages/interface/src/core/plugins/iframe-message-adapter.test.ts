// packages/interface/src/core/plugins/iframe-message-adapter.test.ts
import { describe, expect, it, mock } from 'bun:test';
import { createAppHost } from '../app-shell/host';
import { iframeMessageAdapterPlugin } from './iframe-message-adapter';

function fireMessage(type: string, extra: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type, ...extra },
    origin: window.location.origin,   // trusted origin per isTrustedMessageOrigin
  }));
}

describe('iframe-message-adapter', () => {
  it('VAG_EDITOR_REF → bus.emit editor:ref', async () => {
    const { host, control } = createAppHost();
    control.beginSetup(iframeMessageAdapterPlugin as any);
    const ctx: any = { host, bus: host.bus, storage: host.storage, log: console,
      registerCommand: (c: any) => host.commands.register(c) };
    const cleanup = iframeMessageAdapterPlugin.setup(ctx) as (() => void);
    control.endSetup();

    const seen = mock((_: unknown) => {});
    host.bus.on('editor:ref', seen);
    fireMessage('VAG_EDITOR_REF', { payload: { kind: 'entity', id: 1, name: 'x' } });
    expect(seen).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('FORGEAX_ADD_ASSET_TO_CHAT → bus.emit iframe:add-asset', () => {
    const { host, control } = createAppHost();
    control.beginSetup(iframeMessageAdapterPlugin as any);
    const ctx: any = { host, bus: host.bus, storage: host.storage, log: console,
      registerCommand: (c: any) => host.commands.register(c) };
    const cleanup = iframeMessageAdapterPlugin.setup(ctx) as (() => void);
    control.endSetup();

    const seen = mock((_: unknown) => {});
    host.bus.on('iframe:add-asset', seen);
    fireMessage('FORGEAX_ADD_ASSET_TO_CHAT', { refs: [{ type: 'asset', guid: 'g1' }] });
    expect(seen).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('FORGEAX_FOCUS_PANEL → commands.execute app.panel.focus', async () => {
    const { host, control } = createAppHost();
    control.beginSetup(iframeMessageAdapterPlugin as any);
    const ctx: any = { host, bus: host.bus, storage: host.storage, log: console,
      registerCommand: (c: any) => host.commands.register(c) };
    const cleanup = iframeMessageAdapterPlugin.setup(ctx) as (() => void);
    control.endSetup();

    const seen = mock((_: unknown) => {});
    host.commands.register({ id: 'app.panel.focus', execute: (a) => { seen(a); return 'ok'; } });
    fireMessage('FORGEAX_FOCUS_PANEL', { panel: 'mesh' });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveBeenCalledWith({ id: 'ep:mesh' });
    cleanup();
  });

  it('cleanup removes the window listener', () => {
    const { host, control } = createAppHost();
    control.beginSetup(iframeMessageAdapterPlugin as any);
    const ctx: any = { host, bus: host.bus, storage: host.storage, log: console,
      registerCommand: (c: any) => host.commands.register(c) };
    const cleanup = iframeMessageAdapterPlugin.setup(ctx) as (() => void);
    control.endSetup();
    cleanup();
    const seen = mock((_: unknown) => {});
    host.bus.on('editor:ref', seen);
    fireMessage('VAG_EDITOR_REF', { payload: { kind: 'entity', id: 1, name: 'x' } });
    expect(seen).not.toHaveBeenCalled();
  });
});
