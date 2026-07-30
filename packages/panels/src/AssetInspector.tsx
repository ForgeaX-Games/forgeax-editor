import { Suspense, useCallback } from 'react';
import { useAssetSelection, gateway } from '@forgeax/editor-core';
import { prompt as promptDialog } from '@forgeax/editor-ui';
import { PREVIEW_COMPONENTS } from './asset-inspector';

const KIND_BADGE: Record<string, string> = {
  mesh: '◫', texture: '🖼', 'cube-texture': '🧊', sampler: '⚙',
  material: '🎨', scene: '🗺', shader: '📜', skeleton: '🦴',
  skin: '🩻', 'animation-clip': '🎬', audio: '🔊', font: '🔤',
  'render-pipeline': '🔧', tileset: '🧱',
};

export function AssetInspectorPanel() {
  // useSelectedAssetIdentity is the producer-owned identity contract; the
  // existing barrel exposes its compatible selection hook for this panel.
  const asset = useAssetSelection();

  const handleRename = useCallback(() => {
    if (!asset) return;
    void (async () => {
      const newName = await promptDialog({
        title: 'Rename Asset',
        label: 'New name',
        defaultValue: asset.name,
        confirmText: 'Rename',
        cancelText: 'Cancel',
      });
      if (newName && newName !== asset.name) {
        gateway.dispatch({ kind: 'renameAsset', packPath: asset.packPath, guid: asset.guid, newName, oldName: asset.name }, 'human');
      }
    })();
  }, [asset]);

  const handleDuplicate = useCallback(() => {
    if (!asset) return;
    gateway.dispatch({ kind: 'duplicateAsset', packPath: asset.packPath, guid: asset.guid }, 'human');
  }, [asset]);

  const handleDelete = useCallback(() => {
    if (!asset) return;
    gateway.dispatch({ kind: 'destroyAsset', packPath: asset.packPath, guid: asset.guid }, 'human');
  }, [asset]);

  const handleShowInCB = useCallback(() => {
    if (!asset) return;
    const dir = asset.packPath.substring(0, asset.packPath.lastIndexOf('/')) || 'assets';
    gateway.dispatch({ kind: 'setCBPath', path: dir }, 'human');
  }, [asset]);

  if (!asset) {
    return (
      <div className="panel" data-testid="panel-asset-inspector">
        <h3>Asset Inspector</h3>
        <div className="field muted">Select an asset in the Content Browser to inspect it.</div>
      </div>
    );
  }

  const Preview = PREVIEW_COMPONENTS[asset.kind];

  return (
    <div
      className="panel"
      data-testid="panel-asset-inspector"
      data-facts="product"
      data-projection-source="editor-product"
      data-subject-id={asset.guid}
    >
      <div className="asset-inspector-header">
        <h3>
          <span className="asset-inspector-badge">{KIND_BADGE[asset.kind] ?? '📦'}</span>
          {' '}{asset.name}
          <span className="asset-inspector-kind">{asset.kind}</span>
        </h3>
        <div className="field muted" style={{ fontSize: '0.85em', wordBreak: 'break-all' }}>
          {asset.guid}
        </div>
        <div className="asset-inspector-actions" style={{ display: 'flex', gap: 4, marginTop: 4, marginBottom: 8 }}>
          <button
            className="action-btn"
            data-testid="ai-rename"
            onClick={handleRename}
            title="Rename"
            style={{ fontSize: '0.75em', cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 3, padding: '2px 6px', background: 'transparent', color: 'var(--text)' }}
          >
            🖉 Rename
          </button>
          <button
            className="action-btn"
            data-testid="ai-duplicate"
            onClick={handleDuplicate}
            title="Duplicate"
            style={{ fontSize: '0.75em', cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 3, padding: '2px 6px', background: 'transparent', color: 'var(--text)' }}
          >
            📋 Duplicate
          </button>
          <button
            className="action-btn"
            data-testid="ai-delete"
            onClick={handleDelete}
            title="Delete"
            style={{ fontSize: '0.75em', cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 3, padding: '2px 6px', background: 'transparent', color: 'var(--text-danger, #e53e3e)' }}
          >
            🗑 Delete
          </button>
          <button
            className="action-btn"
            data-testid="ai-show-cb"
            onClick={handleShowInCB}
            title="Show in Content Browser"
            style={{ fontSize: '0.75em', cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 3, padding: '2px 6px', background: 'transparent', color: 'var(--text)' }}
          >
            📂 Show in CB
          </button>
        </div>
      </div>
      {Preview ? (
        <Suspense fallback={<div className="field muted">Loading preview…</div>}>
          <Preview payload={asset.payload} />
        </Suspense>
      ) : (
        <div className="field muted">No preview available for kind "{asset.kind}".</div>
      )}
    </div>
  );
}
