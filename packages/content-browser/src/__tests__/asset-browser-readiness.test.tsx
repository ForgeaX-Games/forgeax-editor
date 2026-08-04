import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { gateway, panelBridge } from '@forgeax/editor-core';
import { useAssetBrowserSnapshot } from '../hooks/useAssetBrowserSnapshot';

try { GlobalRegistrator.register(); } catch { /* another content-browser DOM test already registered it */ }
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const registry = {
  listCatalog: () => [{
    guid: 'asset-ready',
    kind: 'mesh',
    name: 'Ready Asset',
    packageUrl: 'catalog/ready.pack.json',
    sourcePath: 'catalog/ready.glb',
  }],
  refreshCatalog: async () => true,
};
const catalogRoots: readonly never[] = [];

function Probe({ children }: { children?: ReactNode }) {
  const { snapshot } = useAssetBrowserSnapshot('demo', catalogRoots);
  return <output data-testid="assets">{snapshot.assets.map(asset => asset.name).join(',')}{children}</output>;
}

let container: HTMLDivElement;
let root: Root;
let originalFetch: typeof globalThis.fetch;
let originalRegistry: typeof gateway.doc.registry;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  originalFetch = globalThis.fetch;
  originalRegistry = gateway.doc.registry;
  gateway.doc.registry = undefined;
  globalThis.fetch = (async () => new Response(JSON.stringify({ tree: null }), {
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = originalFetch;
  gateway.doc.registry = originalRegistry;
});

describe('Content Browser initial readiness', () => {
  it('re-reads a registry that becomes available on assetsChanged', async () => {
    act(() => root.render(<Probe />));
    expect(container.querySelector('[data-testid="assets"]')?.textContent).toBe('');

    await act(async () => {
      gateway.doc.registry = registry as never;
      panelBridge.emit('assetsChanged', { hint: 'pack-changed', source: 'local-op' });
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="assets"]')?.textContent).toBe('Ready Asset');
  });
});
