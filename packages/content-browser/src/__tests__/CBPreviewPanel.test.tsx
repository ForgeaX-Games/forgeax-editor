import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { CBPreviewPanel, type CBPreviewPanelProps } from '../CBPreviewPanel';
import type { CBAsset, CBFile, CBFolder } from '../types';

try { GlobalRegistrator.register(); } catch { /* another content-browser DOM test already registered it */ }
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const folder: CBFolder = {
  type: 'folder', path: 'assets/hello', name: 'hello', childCount: 0, isFavorite: false,
};
const image: CBFile = {
  type: 'file', path: 'assets/logo.png', diskPath: '/projects/demo/assets/logo.png',
  name: 'logo.png', family: 'image', assets: [], isAssetPackage: false, kindLabel: 'Image', isFavorite: false,
};
const sourceFile: CBFile = {
  type: 'file', path: 'assets/model.glb', diskPath: '/projects/demo/assets/model.glb',
  name: 'model.glb', family: 'model', assets: [{
    type: 'asset', guid: '11111111-1111-4111-8111-111111111111', kind: 'mesh', name: 'model.glb',
    payload: {}, packPath: 'assets/model.pack.json', packIndex: 0, refs: [],
}], isAssetPackage: true, kindLabel: 'Asset Package', isFavorite: false,
};
const packFile: CBFile = {
  type: 'file', path: 'assets/materials.pack.json', diskPath: '/projects/demo/assets/materials.pack.json',
  name: 'materials.pack.json', family: 'pack', assets: [{
    type: 'asset', guid: '33333333-3333-4333-8333-333333333333', kind: 'material', name: 'Metal',
    payload: {}, packPath: 'assets/materials.pack.json', packIndex: 0, refs: [],
  }, {
    type: 'asset', guid: '44444444-4444-4444-8444-444444444444', kind: 'material', name: 'Wood',
    payload: {}, packPath: 'assets/materials.pack.json', packIndex: 1, refs: [],
  }], isAssetPackage: true, kindLabel: 'Asset Pack', isFavorite: false,
};
const textFile: CBFile = {
  type: 'file', path: 'assets/readme.md', diskPath: '/projects/demo/assets/readme.md',
  name: 'readme.md', family: 'doc', assets: [], isAssetPackage: false, kindLabel: 'Document', isFavorite: false,
};
const asset: CBAsset = {
  type: 'asset', guid: '22222222-2222-4222-8222-222222222222', kind: 'material', name: 'Metal',
  payload: {}, packPath: 'assets/materials.pack.json', packIndex: 0, refs: [],
};

let container: HTMLDivElement;
let root: Root;
let originalFetch: typeof globalThis.fetch;

function renderPreview(previewItem: CBPreviewPanelProps['previewItem']): void {
  act(() => root.render(
    <CBPreviewPanel
      previewItem={previewItem}
      foldersInPath={[folder]}
      diskFiles={[]}
      gameSlug="demo"
      onClose={() => {}}
      onDrag={() => {}}
      onDragEnd={() => {}}
    />,
  ));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    path: '/projects/demo/assets/model.glb', kind: 'model', mime: 'model/gltf-binary', size: 2, mtime: 1,
    content: 'preview text',
  }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = originalFetch;
});

describe('Content Browser preview panel', () => {
  it('projects folders, files with source assets, and registry assets', async () => {
    renderPreview(folder);
    expect(container.querySelector('.cb-preview-panel')).not.toBeNull();
    expect(container.textContent).toContain('hello');
    expect(container.textContent).toContain('Empty folder');

    renderPreview(image);
    expect(container.querySelector('img')?.getAttribute('src')).toContain('/api/files/raw');

    renderPreview(sourceFile);
    expect(container.textContent).toContain('model.glb');
    expect(container.querySelector('.cb-preview-asset-row')).not.toBeNull();
    expect(container.querySelector('.cb-preview-mode-bar')).toBeNull();

    renderPreview(packFile);
    expect(container.querySelector('.cb-preview-mode-bar')).not.toBeNull();
    expect(container.textContent).toContain('Assets');
    act(() => {
      container.querySelector<HTMLButtonElement>('.cb-preview-mode-btn:last-child')?.click();
    });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('preview text');

    renderPreview(textFile);
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('preview text');

    renderPreview(asset);
    expect(container.textContent).toContain('Metal');
    expect(container.textContent).toContain('assets/materials.pack.json');
  });
});
