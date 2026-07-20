import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PanelRenderersProvider, type PanelRenderers } from './panelRenderers';

const DEFAULT_RENDERERS: PanelRenderers = {
  editorPanelIds: [],
};

describe('DockPanelHost', () => {
  let host: HTMLDivElement;
  let root: Root;
  let registered = false;

  beforeEach(() => {
    try { GlobalRegistrator.register(); registered = true; } catch { registered = false; }
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    if (registered) GlobalRegistrator.unregister();
  });

  it('renders the body registered under the given panel id with a DockPanel:<id> marker', async () => {
    const { DockPanelHost } = await import('./DockPanelHost');
    const renderers: PanelRenderers = {
      ...DEFAULT_RENDERERS,
      panels: { chat: { title: 'Chat', render: () => <span>chat-body</span> } },
    };
    act(() => {
      root.render(
        <PanelRenderersProvider value={renderers}>
          <DockPanelHost id="chat" />
        </PanelRenderersProvider>,
      );
    });
    expect(host.textContent).toContain('chat-body');
    const marker = host.querySelector('[data-fx-slot="DockPanel:chat"]');
    expect(marker).not.toBeNull();
  });

  it('renders a placeholder when no body is registered for the id', async () => {
    const { DockPanelHost } = await import('./DockPanelHost');
    act(() => {
      root.render(
        <PanelRenderersProvider value={DEFAULT_RENDERERS}>
          <DockPanelHost id="hierarchy" />
        </PanelRenderersProvider>,
      );
    });
    // Marker still present (so the debug overlay shows the empty slot).
    expect(host.querySelector('[data-fx-slot="DockPanel:hierarchy"]')).not.toBeNull();
    // Placeholder body present.
    expect(host.textContent).toContain('Panel not mounted');
  });
});
