// Asset document panels — page-local projections for semantic asset editors.
//
// These are deliberately separate dock panels, not one enlarged Asset
// Inspector. The active editor document is their shared subject SSOT, while the
// document scope decides which panels may coexist (for example mesh-slots only
// exists on a mesh page and can never leak into the Level page).
import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  panelBridge,
  queryViewportRuntimeProjection,
  subscribeViewportRuntimeClient,
  useActiveEditorAsset,
  type SelectedAsset,
} from '@forgeax/editor-core';
import { PREVIEW_COMPONENTS } from './asset-inspector';
import { InspectorSection } from './asset-inspector/InspectorSection';
import InputMapEditor from './asset-inspector/InputMapEditor';
import { AssetPicker, anchorFromElement, type AssetPickerAnchor } from './AssetPicker';
import { getMaterialInstancePreview } from './mi-preview-slot';
import { getMeshPreview } from './mesh-preview-slot';
import { getTexturePreview } from './texture-preview-slot';
import { MeshAuthoringError, saveMeshMaterialSlotDefault } from './mesh-material-slot-authoring';
import { readRuntimeAssetCatalog, type RuntimeAssetCatalogRow } from './runtime-asset-catalog';
import './inspector.css';
import './mi-preview.css';

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

function useRuntimeAssetCatalog(): readonly RuntimeAssetCatalogRow[] {
  const [rows, setRows] = useState<readonly RuntimeAssetCatalogRow[]>([]);
  const refresh = useCallback(() => {
    void readRuntimeAssetCatalog().then(setRows).catch(() => setRows([]));
  }, []);
  useEffect(() => {
    refresh();
    return panelBridge.on('assetsChanged', refresh);
  }, [refresh]);
  useEffect(() => subscribeViewportRuntimeClient(refresh), [refresh]);
  return rows;
}

function EmptyAssetPage(): ReactElement {
  return <div className="field muted">No asset document is active.</div>;
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

interface MeshMaterialSlotProjection {
  readonly slotName?: unknown;
  readonly sourceKey?: unknown;
  readonly defaultMaterial?: unknown;
}

interface MeshSubmeshProjection {
  readonly materialSlot?: unknown;
}

function formatAssetGuid(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (!(value instanceof Uint8Array) || value.length !== 16) return undefined;
  const hex = [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

/** Texture GPU preview panel — UE-style orthographic texture editor viewport. */
export function TexturePreviewPanel(): ReactElement {
  const asset = useDocumentAsset();
  const Preview = getTexturePreview();
  return (
    <div className="panel" data-testid="panel-texture-preview" data-subject-id={asset?.guid}>
      {asset?.kind !== 'texture' && asset?.kind !== 'image' ? <EmptyAssetPage /> : Preview ? (
        <Preview />
      ) : (
        <div className="field muted">
          Texture preview viewport is not registered by the host.
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
  const [pickerSlot, setPickerSlot] = useState<{ index: number; anchor: AssetPickerAnchor } | null>(null);
  const [savingSlot, setSavingSlot] = useState<number | null>(null);
  const [error, setError] = useState<MeshAuthoringError | null>(null);
  const slots = asset?.kind === 'mesh' && Array.isArray(asset.payload.materialSlots)
    ? asset.payload.materialSlots as MeshMaterialSlotProjection[]
    : [];
  const submeshes = asset?.kind === 'mesh' && Array.isArray(asset.payload.submeshes)
    ? asset.payload.submeshes as MeshSubmeshProjection[]
    : [];
  const catalog = useRuntimeAssetCatalog();
  const meshRow = asset === null ? undefined : catalog.find((row) => row.guid.toLowerCase() === asset.guid.toLowerCase());
  const writable = meshRow?.sourceKey !== undefined
    && meshRow.sourceOverrides?.[meshRow.sourceKey] !== undefined
    && meshRow.sourceOverrideDescriptors?.some((descriptor) => (
      descriptor.sourceKey === meshRow.sourceKey
      && descriptor.semantic === 'mesh-material-slot-defaults'
    )) === true;
  const materialName = (guid: string | undefined): string => {
    if (guid === undefined) return 'Engine default material';
    const row = catalog.find((entry) => entry.guid.toLowerCase() === guid.toLowerCase());
    return row?.name?.trim() || guid;
  };
  const saveSlot = async (index: number, materialGuid?: string | null): Promise<void> => {
    const slot = slots[index];
    if (!asset || slot === undefined) return;
    setSavingSlot(index);
    setError(null);
    try {
      await saveMeshMaterialSlotDefault({
        meshGuid: asset.guid,
        slotName: typeof slot.slotName === 'string' && slot.slotName.length > 0 ? slot.slotName : `Slot ${index}`,
        ...(typeof slot.sourceKey === 'string' && slot.sourceKey.length > 0 ? { slotSourceKey: slot.sourceKey } : {}),
        ...(materialGuid === undefined ? {} : { materialGuid }),
      });
    } catch (cause) {
      setError(cause instanceof MeshAuthoringError ? cause : new MeshAuthoringError({
        code: 'mesh-authoring-unhandled',
        expected: 'the Mesh authoring operation to complete',
        hint: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
        recoveryActions: ['authoring.retry'],
      }));
    } finally {
      setSavingSlot(null);
    }
  };

  return (
    <div className="panel fx-inspector" data-testid="panel-mesh-slots" data-subject-id={asset?.guid}>
      {asset?.kind !== 'mesh' ? <EmptyAssetPage /> : (
        <>
          {!writable && <div className="bespoke-hint">This Mesh has no writable imported source metadata.</div>}
          {error && <div className="bespoke-hint" data-testid="mesh-slot-save-error" data-error-code={error.code} style={{ color: 'var(--color-text-danger, #e66)' }}>
            {error.hint}
            {error.recoveryActions !== undefined && error.recoveryActions.length > 0 ? ` (${error.recoveryActions.join(', ')})` : ''}
          </div>}
          <InspectorSection id="slots" title="Slots" dim="type">
            {slots.length === 0 ? (
              <div className="bespoke-hint">No material slots in this mesh.</div>
            ) : slots.map((slot, index) => {
              const slotName = typeof slot.slotName === 'string' && slot.slotName.length > 0 ? slot.slotName : `Slot ${index}`;
              const guid = formatAssetGuid(slot.defaultMaterial);
              const bound = guid !== undefined;
              const matName = materialName(guid);
              const sectionCount = submeshes.filter((submesh) => submesh.materialSlot === index).length;
              const busy = savingSlot === index;
              return (
                <div className="f-row mesh-slot-row" data-testid={`mesh-slot-${index}`} key={index}>
                  <span className="f-name" title={slotName}>{slotName}</span>
                  <span className="f-val">
                    <span
                      className="asset-f"
                      role="button"
                      tabIndex={writable ? 0 : -1}
                      aria-disabled={!writable || savingSlot !== null}
                      data-testid={`mesh-slot-material-${index}`}
                      title={writable ? 'Click to assign a material' : 'Imported source metadata is read-only'}
                      onClick={(event) => {
                        if (!writable || savingSlot !== null) return;
                        const rect = anchorFromElement(event.currentTarget);
                        if (rect) setPickerSlot({ index, anchor: rect });
                      }}
                      onKeyDown={(e) => {
                        if ((e.key === 'Enter' || e.key === ' ') && writable && savingSlot === null) {
                          e.preventDefault();
                          const rect = anchorFromElement(e.currentTarget);
                          if (rect) setPickerSlot({ index, anchor: rect });
                        }
                      }}
                    >
                      <span className={`ab${bound ? '' : ' empty'}`} />
                      <span className={`an${bound ? '' : ' empty'}`} title={matName}>{busy ? 'Saving…' : matName}</span>
                    </span>
                    {writable && (
                      <span className="mesh-slot-actions">
                        <button
                          type="button"
                          className="fbtn"
                          data-testid={`mesh-slot-engine-default-${index}`}
                          disabled={savingSlot !== null}
                          title="Author an explicit neutral Engine material for this slot"
                          onClick={() => { void saveSlot(index, null); }}
                        >Engine Default</button>
                        <button
                          type="button"
                          className="fbtn"
                          data-testid={`mesh-slot-follow-source-${index}`}
                          disabled={savingSlot !== null}
                          title="Remove the authored override and follow the imported source material"
                          onClick={() => { void saveSlot(index); }}
                        >Follow Source</button>
                      </span>
                    )}
                    <span className="mesh-slot-sections">
                      {typeof slot.sourceKey === 'string' && slot.sourceKey.length > 0 ? `${slot.sourceKey} · ` : ''}
                      {`${sectionCount} section${sectionCount === 1 ? '' : 's'}`}
                    </span>
                  </span>
                </div>
              );
            })}
          </InspectorSection>
          {pickerSlot !== null && slots[pickerSlot.index] !== undefined && (
            <AssetPicker
              assetType="MaterialAsset"
              anchor={pickerSlot.anchor}
              currentGuid={formatAssetGuid(slots[pickerSlot.index]?.defaultMaterial) ?? null}
              onPick={(guid) => { void saveSlot(pickerSlot.index, guid); }}
              onClose={() => setPickerSlot(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
