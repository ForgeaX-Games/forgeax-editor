import { useCallback, useRef, useState } from 'react';
import { broadcastAssetsChanged, resolveGamePath } from '@forgeax/editor-shared';
import { generateAssetGuid, addAssetToPack, createPack, createDirectory } from '@forgeax/editor-core';
import { ASSET_KINDS, type AssetKind } from './types';

interface Props {
  currentPath: string;
  onReload: () => void;
}

const KIND_ICONS: Record<string, string> = {
  mesh: '◫', texture: '🖼', 'cube-texture': '🧊', sampler: '⚙',
  material: '🎨', scene: '🗺', shader: '📜', skeleton: '🦴',
  skin: '🩻', 'animation-clip': '🎬', audio: '🔊', font: '🔤',
  'render-pipeline': '🔧', tileset: '🧱',
};

const EMPTY_PAYLOADS: Partial<Record<AssetKind, () => Record<string, unknown>>> = {
  material: () => ({ kind: 'material', passes: [], paramValues: { baseColor: [0.8, 0.8, 0.8, 1.0] } }),
  scene: () => ({ kind: 'scene', nodes: [] }),
  shader: () => ({ kind: 'shader', source: '// WGSL shader\n' }),
};

export function CBToolbar({ currentPath, onReload }: Props) {
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const basePath = resolveGamePath(currentPath || 'assets');

  const handleCreateAsset = useCallback(async (kind: AssetKind) => {
    setAddMenuOpen(false);
    const name = window.prompt(`New ${kind} name:`);
    if (!name) return;

    const packPath = `${basePath}/${name}.pack.json`;
    const guid = generateAssetGuid();
    const payloadFactory = EMPTY_PAYLOADS[kind];
    const payload = payloadFactory ? payloadFactory() : { kind };

    const created = await createPack(basePath, name);
    if (created) {
      await addAssetToPack(created, { guid, kind, name, payload });
    } else {
      await addAssetToPack(packPath, { guid, kind, name, payload });
    }
    broadcastAssetsChanged();
    onReload();
  }, [basePath, onReload]);

  const handleNewFolder = useCallback(async () => {
    setAddMenuOpen(false);
    const name = window.prompt('New folder name:');
    if (!name) return;
    await createDirectory(`${basePath}/${name}`);
    onReload();
  }, [basePath, onReload]);

  const handleImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (const file of Array.from(files)) {
      try {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        const data = btoa(binary);

        const r = await fetch('/api/files/upload', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: `${basePath}/${file.name}`, data }),
        });
        if (!r.ok) console.warn('[CBToolbar] upload failed:', file.name, r.status);
      } catch (err) {
        console.warn('[CBToolbar] upload error:', file.name, err);
      }
    }
    broadcastAssetsChanged();
    onReload();
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [basePath, onReload]);

  const handleSaveAll = useCallback(() => {
    broadcastAssetsChanged();
  }, []);

  return (
    <div className="cb-toolbar">
      <div className="cb-toolbar-group">
        <div className="cb-dropdown-container">
          <button className="cb-toolbar-btn" onClick={() => setAddMenuOpen(!addMenuOpen)}>
            + Add
          </button>
          {addMenuOpen && (
            <div className="cb-dropdown-menu" onMouseLeave={() => setAddMenuOpen(false)}>
              <button className="cb-dropdown-item" onClick={handleNewFolder}>
                📁 New Folder
              </button>
              <div className="cb-dropdown-sep" />
              {ASSET_KINDS.map(kind => (
                <button key={kind} className="cb-dropdown-item" onClick={() => void handleCreateAsset(kind)}>
                  {KIND_ICONS[kind] ?? '📦'} {kind}
                </button>
              ))}
            </div>
          )}
        </div>

        <button className="cb-toolbar-btn" onClick={handleImport}>
          ⬇ Import
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".glb,.gltf,.png,.jpg,.jpeg,.webp,.ttf,.otf,.wav,.mp3,.ogg"
          style={{ display: 'none' }}
          onChange={e => void handleFileSelected(e)}
        />

        <button className="cb-toolbar-btn" onClick={handleSaveAll}>
          💾 Save All
        </button>
      </div>
    </div>
  );
}
