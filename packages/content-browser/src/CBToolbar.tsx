import { useCallback, useEffect, useRef, useState } from 'react';
import { broadcastAssetsChanged, resolveGamePath } from '@forgeax/editor-core';
import { generateAssetGuid, gateway } from '@forgeax/editor-core';
import { importFiles, type ImportProgress } from './import-pipeline';
import { buildAcceptString, logImport } from './import-registry';
import { CREATABLE_ASSET_KINDS, type CreatableAssetSpec } from './creatable-asset-kinds';

interface Props {
  currentPath: string;
  onReload: () => void;
  onImportProgress?: (progress: ImportProgress | null) => void;
}

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

  const handleCreateAsset = useCallback((spec: CreatableAssetSpec) => {
    setAddMenuOpen(false);
    const name = window.prompt(`New ${spec.label} name:`, spec.defaultNamePrefix);
    if (!name) return;
    gateway.dispatch({
      kind: 'createAsset',
      packPath: `${basePath}/${name}.pack.json`,
      guid: generateAssetGuid(),
      assetKind: spec.kind,
      name,
    }, 'human');
  }, [basePath]);

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
              {CREATABLE_ASSET_KINDS.map(spec => (
                <button key={spec.kind} className="cb-dropdown-item" onClick={() => handleCreateAsset(spec)}>
                  {spec.icon} {spec.label}
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
