import { useCallback, useEffect, useRef, useState } from 'react';
import { broadcastAssetsChanged, resolveGamePath } from '@forgeax/editor-core';
import { generateAssetGuid, addAssetToPack, createPack, gateway } from '@forgeax/editor-core';
import { ASSET_KINDS, type AssetKind } from './types';
import { importFiles, type ImportProgress } from './import-pipeline';
import { buildAcceptString, logImport } from './import-registry';

interface Props {
  currentPath: string;
  onReload: () => void;
  onImportProgress?: (progress: ImportProgress | null) => void;
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

export function CBToolbar({ currentPath, onReload, onImportProgress }: Props) {
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const acceptString = buildAcceptString();

  const basePath = resolveGamePath(currentPath || 'assets');

  useEffect(() => {
    const input = fileInputRef.current;
    logImport('CBToolbar.mount', {
      currentPath,
      basePath,
      accept: acceptString,
      hasFbx: acceptString.includes('.fbx'),
      acceptDom: input?.getAttribute('accept') ?? input?.accept ?? null,
    });
  }, [acceptString, basePath, currentPath]);

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

  const handleNewFolder = useCallback(() => {
    setAddMenuOpen(false);
    const name = window.prompt('New folder name:');
    if (!name) return;
    gateway.dispatch({ kind: 'createDirectory', parentPath: currentPath, name }, 'human');
  }, [currentPath]);

  const handleImport = useCallback(() => {
    const input = fileInputRef.current;
    logImport('CBToolbar.import.click', {
      currentPath,
      basePath,
      accept: acceptString,
      hasFbx: acceptString.includes('.fbx'),
      acceptDom: input?.getAttribute('accept') ?? input?.accept ?? null,
    });
    input?.click();
  }, [acceptString, basePath, currentPath]);

  const handleFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) {
      logImport('CBToolbar.import.cancel', { reason: 'no files selected' });
      return;
    }

    logImport('CBToolbar.import.selected', {
      count: files.length,
      names: Array.from(files).map(f => f.name),
      currentPath,
      basePath,
    });

    onImportProgress?.({ total: files.length, completed: 0, current: '', results: [] });

    const results = await importFiles(
      Array.from(files),
      currentPath,
      (progress) => onImportProgress?.(progress),
      onReload,
    );

    logImport('CBToolbar.import.done', {
      results: results.map(r => ({ filename: r.filename, status: r.status, error: r.error })),
    });

    const errors = results.filter(r => r.status === 'error');
    if (errors.length > 0) {
      console.warn('[CBToolbar] import errors:', errors.map(e => `${e.filename}: ${e.error}`));
    }

    setTimeout(() => onImportProgress?.(null), 3000);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [currentPath, onReload, onImportProgress]);

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
          accept={acceptString}
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
