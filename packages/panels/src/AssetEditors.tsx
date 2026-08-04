// Asset document panels — page-local projections for semantic asset editors.
//
// These are deliberately separate dock panels, not one enlarged Asset
// Inspector. The active editor document is their shared subject SSOT, while the
// document scope decides which panels may coexist (for example mesh-slots only
// exists on a mesh page and can never leak into the Level page).
import { Suspense, useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  ensureAssetCataloged,
  gateway,
  panelBridge,
  useActiveEditorAsset,
} from '@forgeax/editor-core';
import type { SelectedAsset } from '@forgeax/editor-core';
import { prompt as promptDialog } from '@forgeax/editor-ui';
import { PREVIEW_COMPONENTS } from './asset-inspector';
import './inspector.css';

const KIND_BADGE: Record<string, string> = {
  mesh: '◫', texture: '🖼', 'cube-texture': '🧊g', sampler: '⚙',
  material: '🎨', scene: '🗺', shader: '📜', skeleton: '🦴',
  skin: '🩻', 'animation-clip': '🎬', audio: '🔊', font: '🔤',
  'render-pipeline': '🔧', tileset: '🧱',
};

function useDocumentAsset(): SelectedAsset | null {
  const asset = useActiveEditorAsset();
  const [version, setVersion] = useState(0);

  useEffect(() => panelBridge.on('assetsChanged', () => setVersion((value) => value + 1)), []);
  useEffect(() => {
    if (!asset || gateway.lookupAsset(asset.guid) !== undefined) return;
    let cancelled = false;
    void ensureAssetCataloged(gateway.doc.registry, asset.guid).then((loaded) => {
      if (loaded && !cancelled) setVersion((value) => value + 1);
    });
    return () => { cancelled = true; };
  }, [asset?.guid, version]);

  return useMemo(() => {
    void version;
    if (!asset) return null;
    const payload = gateway.lookupAsset(asset.guid) as Record<string, unknown> | undefined;
    return payload === undefined ? asset : { ...asset, payload };
  }, [asset, version]);
}

function EmptyAssetPage(): ReactElement {
  return <div className="field muted">No asset document is active.</div>;
}

/** Identity and lifecycle actions shared by every asset editor page. */
export function AssetOverviewPanel(): ReactElement {
  const asset = useDocumentAsset();

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
    if (asset) gateway.dispatch({ kind: 'duplicateAsset', packPath: asset.packPath, guid: asset.guid }, 'human');
  }, [asset]);

  const handleDelete = useCallback(() => {
    if (asset) gateway.dispatch({ kind: 'destroyAsset', guid: asset.guid }, 'human');
  }, [asset]);

  const handleShowInCB = useCallback(() => {
    if (!asset) return;
    const dir = asset.packPath.substring(0, asset.packPath.lastIndexOf('/')) || 'assets';
    gateway.dispatch({ kind: 'setCBPath', path: dir }, 'human');
  }, [asset]);

  return (
    <div className="panel" data-testid="panel-asset-overview" data-subject-id={asset?.guid}>
      {!asset ? <EmptyAssetPage /> : (
        <>
          <div className="asset-inspector-header">
            <h3>
              <span className="asset-inspector-badge">{KIND_BADGE[asset.kind] ?? '📦'}</span>
              {' '}{asset.name}
              <span className="asset-inspector-kind">{asset.kind}</span>
            </h3>
            <div className="field muted" style={{ fontSize: '0.85em', wordBreak: 'break-all' }}>{asset.guid}</div>
            <div className="field muted" style={{ fontSize: '0.85em', wordBreak: 'break-all' }}>{asset.packPath}</div>
          </div>
          <div className="asset-inspector-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
            <button className="action-btn" data-testid="asset-rename" onClick={handleRename} title="Rename">🖉 Rename</button>
            <button className="action-btn" data-testid="asset-duplicate" onClick={handleDuplicate} title="Duplicate">📋 Duplicate</button>
            <button className="action-btn" data-testid="asset-delete" onClick={handleDelete} title="Delete">🗑 Delete</button>
            <button className="action-btn" data-testid="asset-show-cb" onClick={handleShowInCB} title="Show in Content Browser">📂 Show in CB</button>
          </div>
        </>
      )}
    </div>
  );
}

/** Kind-specific property editor (material parameters, mesh facts, texture
 * properties, and so on) hosted as its own dock panel. */
export function AssetPropertiesPanel(): ReactElement {
  const asset = useDocumentAsset();
  const Properties = asset ? PREVIEW_COMPONENTS[asset.kind] : undefined;
  return (
    <div
      className="panel"
      data-testid="panel-asset-properties"
      data-facts="product"
      data-projection-source="editor-product"
      data-subject-id={asset?.guid}
    >
      {!asset ? <EmptyAssetPage /> : Properties ? (
        <Suspense fallback={<div className="field muted">Loading properties…</div>}>
          <Properties payload={asset.payload} />
        </Suspense>
      ) : (
        <div className="field muted">No property editor is available for kind "{asset.kind}".</div>
      )}
    </div>
  );
}

interface MeshSlot {
  materialIndex?: unknown;
  indexCount?: unknown;
  vertexCount?: unknown;
  topology?: unknown;
}

/** Mesh-only submesh/material-slot projection. The rows are derived from the
 * engine mesh payload; this panel does not invent a second material-binding
 * format. Assignment belongs to the native scene MeshRenderer contract. */
export function MeshSlotsPanel(): ReactElement {
  const asset = useDocumentAsset();
  const slots = asset?.kind === 'mesh' && Array.isArray(asset.payload.submeshes)
    ? asset.payload.submeshes as MeshSlot[]
    : [];

  return (
    <div className="panel" data-testid="panel-mesh-slots" data-subject-id={asset?.guid}>
      {asset?.kind !== 'mesh' ? <EmptyAssetPage /> : (
        <>
          <div className="compname">Material Slots</div>
          {slots.length === 0 ? (
            <div className="field muted">No submesh slots in this mesh.</div>
          ) : slots.map((slot, index) => (
            <div className="f-row" data-testid={`mesh-slot-${index}`} key={index}>
              <span className="f-name">Slot {index}</span>
              <span className="f-val">
                {typeof slot.materialIndex === 'number' ? `Source material ${slot.materialIndex}` : 'Unassigned'}
                <span className="field muted" style={{ marginLeft: 8 }}>
                  {typeof slot.indexCount === 'number' ? `${slot.indexCount} indices` : ''}
                  {typeof slot.vertexCount === 'number' ? ` · ${slot.vertexCount} vertices` : ''}
                  {typeof slot.topology === 'string' ? ` · ${slot.topology}` : ''}
                </span>
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
