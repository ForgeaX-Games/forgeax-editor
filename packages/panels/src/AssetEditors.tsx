// Asset document panels — page-local projections for semantic asset editors.
//
// These are deliberately separate dock panels, not one enlarged Asset
// Inspector. The active editor document is their shared subject SSOT, while the
// document scope decides which panels may coexist (for example mesh-slots only
// exists on a mesh page and can never leak into the Level page).
import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  dispatchActiveEditorOperation,
  gateway,
  panelBridge,
  queryViewportRuntimeProjection,
  subscribeViewportRuntimeClient,
  useActiveEditorAsset,
  type SelectedAsset,
} from '@forgeax/editor-core';
import { prompt as promptDialog } from '@forgeax/editor-ui';
import { PREVIEW_COMPONENTS } from './asset-inspector';
import InputMapEditor from './asset-inspector/InputMapEditor';
import { getMaterialInstancePreview } from './mi-preview-slot';
import { getMeshPreview } from './mesh-preview-slot';
import './inspector.css';
import './mi-preview.css';

const KIND_BADGE: Record<string, string> = {
  mesh: '◫', texture: '🖼', 'cube-texture': '🧊g', sampler: '⚙',
  material: '🎨', 'material-instance': '🎛', scene: '🗺', shader: '📜', skeleton: '🦴',
  skin: '🩻', 'animation-clip': '🎬', audio: '🔊', font: '🔤',
  'render-pipeline': '🔧', tileset: '🧱', 'particle-effect': '✨', 'input-map': '🎮',
};

interface RuntimeAssetPayloadProjection {
  readonly guid: string;
  readonly payload: Record<string, unknown>;
}

const documentPayloadCache = new Map<string, Record<string, unknown>>();
const documentPayloadLoads = new Map<string, Promise<Record<string, unknown> | undefined>>();

/** Resolve one document payload from the authoritative Viewport Runtime. The
 * shell never grows a shadow AssetRegistry; it caches only this disposable,
 * GUID-keyed projection for business panels and bounded preview mini-worlds. */
export function loadDocumentAssetPayload(guid: string): Promise<Record<string, unknown> | undefined> {
  const cached = documentPayloadCache.get(guid);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = documentPayloadLoads.get(guid);
  if (pending !== undefined) return pending;
  const load = queryViewportRuntimeProjection<RuntimeAssetPayloadProjection>({ kind: 'assets.payload', guid })
    .then((envelope) => {
      if (envelope.status !== 'ready' || envelope.value === null) return undefined;
      const payload = envelope.value.payload;
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
      documentPayloadCache.set(guid, payload);
      return payload;
    })
    .catch(() => undefined)
    .finally(() => { documentPayloadLoads.delete(guid); });
  documentPayloadLoads.set(guid, load);
  return load;
}

export function useDocumentAsset(): SelectedAsset | null {
  const asset = useActiveEditorAsset();
  const [version, setVersion] = useState(0);

  useEffect(() => panelBridge.on('assetsChanged', () => {
    if (asset) documentPayloadCache.delete(asset.guid);
    setVersion((value) => value + 1);
  }), [asset?.guid]);
  useEffect(() => subscribeViewportRuntimeClient(() => setVersion((value) => value + 1)), []);
  useEffect(() => {
    if (!asset || documentPayloadCache.has(asset.guid)) return;
    let cancelled = false;
    void loadDocumentAssetPayload(asset.guid).then((loaded) => {
      if (loaded !== undefined && !cancelled) setVersion((value) => value + 1);
    });
    return () => { cancelled = true; };
  }, [asset?.guid, version]);

  return useMemo(() => {
    void version;
    if (!asset) return null;
    const payload = documentPayloadCache.get(asset.guid);
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
        void dispatchActiveEditorOperation({ kind: 'renameAsset', packPath: asset.packPath, guid: asset.guid, newName, oldName: asset.name }, 'human');
      }
    })();
  }, [asset]);

  const handleDuplicate = useCallback(() => {
    if (asset) void dispatchActiveEditorOperation({ kind: 'duplicateAsset', packPath: asset.packPath, guid: asset.guid }, 'human');
  }, [asset]);

  const handleDelete = useCallback(() => {
    if (asset) void dispatchActiveEditorOperation({ kind: 'destroyAsset', guid: asset.guid }, 'human');
  }, [asset]);

  const handleShowInCB = useCallback(() => {
    if (!asset) return;
    const dir = asset.packPath.substring(0, asset.packPath.lastIndexOf('/')) || 'assets';
    // Content Browser navigation is disposable shell chrome, not authored
    // Runtime state. Keep it local until a multi-window navigation owner exists.
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

/** Material Instance 3D preview panel (M5 — viewport injected by edit-runtime/host). */
export function MaterialInstancePreviewPanel(): ReactElement {
  const asset = useDocumentAsset();
  const Preview = getMaterialInstancePreview();
  return (
    <div className="panel" data-testid="panel-mi-preview" data-subject-id={asset?.guid}>
      {asset?.kind !== 'material-instance' ? <EmptyAssetPage /> : Preview ? (
        <Preview />
      ) : (
        <div className="field muted">
          Material Instance preview viewport is not registered by the host.
        </div>
      )}
    </div>
  );
}

/** Base Material 3D preview panel — same host-injected viewport as the MI
 *  page; the registered component branches on the active asset kind. */
export function MaterialPreviewPanel(): ReactElement {
  const asset = useDocumentAsset();
  const Preview = getMaterialInstancePreview();
  return (
    <div className="panel" data-testid="panel-mat-preview" data-subject-id={asset?.guid}>
      {asset?.kind !== 'material' ? <EmptyAssetPage /> : Preview ? (
        <Preview />
      ) : (
        <div className="field muted">
          Material preview viewport is not registered by the host.
        </div>
      )}
    </div>
  );
}

/** Mesh 3D preview panel — runtime-owned independent canvas/world (STD-01). */
export function MeshPreviewPanel(): ReactElement {
  const asset = useDocumentAsset();
  const Preview = getMeshPreview();
  return (
    <div className="panel" data-testid="panel-mesh-preview" data-subject-id={asset?.guid}>
      {asset?.kind !== 'mesh' ? <EmptyAssetPage /> : Preview ? (
        <Preview />
      ) : (
        <div className="field muted">
          Mesh preview viewport is not registered by the host.
        </div>
      )}
    </div>
  );
}

/** Material Instance properties panel (M3: MaterialInstanceEditor). */
export function MaterialInstancePropertiesPanel(): ReactElement {
  const asset = useDocumentAsset();
  return (
    <div className="panel" data-testid="panel-mi-properties" data-subject-id={asset?.guid}>
      {asset?.kind !== 'material-instance' ? <EmptyAssetPage /> : (
        <Suspense fallback={<div className="field muted">Loading properties…</div>}>
          <MaterialInstanceEditorLazy />
        </Suspense>
      )}
    </div>
  );
}

const MaterialInstanceEditorLazy = lazy(() => import('./asset-inspector/MaterialInstanceEditor'));

/** Input Map properties panel — eager import (avoid React.lazy Suspense hang after HMR). */
export function InputMapPropertiesPanel(): ReactElement {
  const asset = useDocumentAsset();
  return (
    <div className="panel" data-testid="panel-input-map-properties" data-subject-id={asset?.guid}>
      {asset?.kind !== 'input-map' ? <EmptyAssetPage /> : <InputMapEditor />}
    </div>
  );
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
