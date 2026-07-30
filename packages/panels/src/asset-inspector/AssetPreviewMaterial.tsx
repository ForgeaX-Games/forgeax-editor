import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAssetSelection, gateway, panelBridge, ensureAssetCataloged } from '@forgeax/editor-core';
import { AssetPicker } from '../AssetPicker';
import { PropertyRow } from './PropertyRow';
import type { PreviewProps } from './index';

interface PassDesc {
  name?: string;
  program?: { module?: string };
}

/** Engine SSOT: user-region texture field names (derive-paramschema.ts:287-291). */
const TEXTURE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
]);

/** Accepted drag-drop kinds for texture assignment. */
const DROPPABLE_TEXTURE_KINDS: ReadonlySet<string> = new Set(['texture', 'image']);

/** Convert linear [0,1] RGB to sRGB hex string. */
function linearToSrgbHex(linear: number[]): string {
  const toSrgb = (c: number) => Math.round(Math.pow(Math.max(0, Math.min(1, c)), 1 / 2.2) * 255);
  const r = toSrgb(linear[0] ?? 0);
  const g = toSrgb(linear[1] ?? 0);
  const b = toSrgb(linear[2] ?? 0);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/** Convert sRGB hex to linear [r,g,b,a] array. */
function srgbHexToLinear(hex: string, alpha: number = 1): [number, number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [1, 1, 1, alpha];
  const fromSrgb = (s: string) => Math.pow(parseInt(s, 16) / 255, 2.2);
  return [fromSrgb(m[1]!), fromSrgb(m[2]!), fromSrgb(m[3]!), alpha];
}

/** From values' stored value (integer refs index OR raw GUID string) resolve
 *  to the actual texture GUID. Pack format stores `values[key] = refs[] index`
 *  (number), while the materialLoader resolves indices back to GUID strings at load
 *  time (may arrive as string). */
function resolveTextureGuid(value: unknown, refs: readonly string[]): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && refs[value]) return refs[value]!;
  return null;
}

// ── TextureSlot: per-field drop zone + browse + display ─────────────────────

interface TextureSlotProps {
  label: string;
  guid: string | null;
  canEdit: boolean;
  onAssign: (textureGuid: string) => void;
  onClear: () => void;
  onBrowse: () => void;
}

function TextureSlot({ label, guid, canEdit, onAssign, onClear, onBrowse }: TextureSlotProps) {
  const [dropHot, setDropHot] = useState(false);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDropHot(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDropHot(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDropHot(false);
    const json = e.dataTransfer.getData('application/x-forgeax-asset');
    if (!json) return;
    try {
      const ref = JSON.parse(json) as { guid?: string; kind?: string; name?: string; packPath?: string };
      if (!ref.guid || !DROPPABLE_TEXTURE_KINDS.has(ref.kind ?? '')) return;
      onAssign(ref.guid);
    } catch { /* malformed drag payload — ignore */ }
  }, [onAssign]);

  const shortGuid = guid && guid.length > 18 ? `${guid.slice(0, 18)}…` : guid;

  return (
    <div
      className={`mat-tex-slot${dropHot ? ' drop-hot' : ''}`}
      data-testid={`mat-${label}`}
      onDragEnter={canEdit ? handleDragEnter : undefined}
      onDragLeave={canEdit ? handleDragLeave : undefined}
      onDragOver={canEdit ? handleDragOver : undefined}
      onDrop={canEdit ? handleDrop : undefined}
    >
      <div className="mat-tex-slot-header">
        <span className="mat-tex-slot-label">{label}</span>
      </div>
      {guid ? (
        <div className="mat-tex-slot-bound">
          <span className="mat-tex-slot-icon">🖼</span>
          <span className="mat-tex-slot-guid" title={`Texture GUID: ${guid}`}>{shortGuid}</span>
          {canEdit && (
            <button
              className="mat-clear-btn"
              title="Clear texture"
              onClick={onClear}
            >
              ✕
            </button>
          )}
        </div>
      ) : (
        <div className="mat-tex-empty">Drop or browse TextureAsset</div>
      )}
      {canEdit && (
        <button className="mat-browse-btn" onClick={onBrowse} title={`Browse ${label}`}>
          📁 Browse
        </button>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

/** Re-read the asset's payload from the catalog after a pack write (Task 5).
 *  The stored `SelectedAsset.payload` is a snapshot from selection time; without
 *  this, editing params (clear/assign texture) won't reflect until the user
 *  clicks away and back. Listening to `assetsChanged` covers the same signal
 *  broadcastAssetsChanged fires after the async writePackEntry lands. */
function useLivePayload(propsPayload: Record<string, unknown>, guid: string | undefined): { payload: Record<string, unknown>; refs: readonly string[] } {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!guid) return;
    const off = panelBridge.on('assetsChanged', () => setVersion(v => v + 1));
    return off;
  }, [guid]);

  // Catalog-miss self-heal: lookupAsset below is catalog-only (no fetch), so a
  // material never loadByGuid'd this session (created before a page reload, or
  // not referenced by the loaded scene) has NO envelope — and updateMaterialParams'
  // synchronous _preFillMaterialOp reads exactly that map, so a texture drop on
  // such a material failed. Load it once on open; the version bump re-reads the
  // live payload afterwards (the envelope is the SSOT, replacing the snapshot).
  // Re-runs on version bumps too: applyUpdateMaterialParams invalidates the
  // envelope after each write, so the post-edit state re-loads from disk here.
  useEffect(() => {
    if (!guid || gateway.lookupAsset(guid) !== undefined) return;
    let cancelled = false;
    void ensureAssetCataloged(gateway.doc.registry, guid).then((loaded) => {
      if (loaded && !cancelled) setVersion(v => v + 1);
    });
    return () => { cancelled = true; };
  }, [guid, version]);

  return useMemo(() => {
    void version; // react to version bumps
    if (!guid) return { payload: propsPayload, refs: [] };
    // lookupAsset returns the LIVE payload (envelope.payload) directly — the
    // post-load SSOT whose texture fields are resolved GUID strings. Refs come
    // from the catalog row (pack-index), which exists even without an envelope.
    const live = gateway.lookupAsset(guid) as Record<string, unknown> | undefined;
    const catalog = gateway.assetCatalog();
    const entry = catalog.find((e: { guid: string; refs?: readonly string[] }) => e.guid === guid);
    return { payload: live ?? propsPayload, refs: entry?.refs ?? [] };
  }, [guid, propsPayload, version]);
}

export default function AssetPreviewMaterial({ payload: propsPayload }: PreviewProps) {
  const asset = useAssetSelection();
  const { payload, refs } = useLivePayload(propsPayload, asset?.guid);
  const passes = Array.isArray(payload.passes) ? (payload.passes as PassDesc[]) : [];
  const parent = payload.parent as string | undefined;
  const values = (payload.values ?? {}) as Record<string, unknown>;

  const baseColor = Array.isArray(values.baseColor) ? values.baseColor as number[] : [1, 1, 1, 1];
  const metallic = typeof values.metallic === 'number' ? values.metallic : 0;
  const roughness = typeof values.roughness === 'number' ? values.roughness : 0.5;

  const [localMetallic, setLocalMetallic] = useState(metallic);
  const [localRoughness, setLocalRoughness] = useState(roughness);
  const [pickerTarget, setPickerTarget] = useState<string | null>(null);

  const canEdit = !!asset?.packPath && !!asset?.guid;

  /** Dispatch an updateMaterialParams op AFTER guaranteeing the material's
   *  payload envelope is cataloged — _preFillMaterialOp reads
   *  registry.assetCatalog synchronously, so dispatching against a never-loaded
   *  material fails with '_oldPatch missing' (the drag-no-response 400). The
   *  mount-time ensure effect above usually wins this race; awaiting here makes
   *  the drop path correct even when it didn't (loadByGuid dedups via inFlight). */
  const dispatchMaterialOp = useCallback((op: {
    paramPatch: Record<string, unknown>;
    textureGuids?: Record<string, string | null>;
  }) => {
    if (!asset) return;
    void (async () => {
      const cataloged = await ensureAssetCataloged(gateway.doc.registry, asset.guid);
      const result = gateway.dispatch({
        kind: 'updateMaterialParams',
        packPath: asset.packPath,
        guid: asset.guid,
        ...op,
      }, 'human');
      if (!result.ok) {
        console.info('[mat-tex-drop]', 'dispatch rejected', {
          guid: asset.guid, packPath: asset.packPath, cataloged,
          error: (result as { error?: unknown }).error,
        });
      }
    })();
  }, [asset]);

  const dispatchParam = useCallback((paramPatch: Record<string, unknown>) => {
    dispatchMaterialOp({ paramPatch });
  }, [dispatchMaterialOp]);

  // Task 1: handleAssignTexture — assign a texture GUID to a named slot.
  // Uses the existing updateMaterialParams op with textureGuids (same path as
  // handleClearTexture, but setting a GUID instead of null). No new op needed.
  const handleAssignTexture = useCallback((key: string, textureGuid: string) => {
    if (!asset) return;
    dispatchMaterialOp({ paramPatch: {}, textureGuids: { [key]: textureGuid } });
  }, [asset, dispatchMaterialOp]);

  const handleClearTexture = useCallback((key: string) => {
    dispatchMaterialOp({ paramPatch: { [key]: undefined }, textureGuids: { [key]: null } });
  }, [dispatchMaterialOp]);

  const handleColorChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const hex = e.target.value;
    const alpha = baseColor[3] ?? 1;
    dispatchParam({ baseColor: srgbHexToLinear(hex, alpha) });
  }, [dispatchParam, baseColor]);

  const handleMetallicCommit = useCallback((val: number) => {
    dispatchParam({ metallic: val });
  }, [dispatchParam]);

  const handleRoughnessCommit = useCallback((val: number) => {
    dispatchParam({ roughness: val });
  }, [dispatchParam]);

  // Collect texture fields that exist in TEXTURE_FIELD_NAMES — always show all
  // three slots (even if undefined) so the user can discover and assign them.
  const textureFields = useMemo(() => {
    return [...TEXTURE_FIELD_NAMES].map(key => ({
      key,
      guid: resolveTextureGuid(values[key], refs),
    }));
  }, [values, refs]);

  return (
    <div data-testid="preview-material" className="mat-editor">
      <div className="compname">Material</div>

      {/* Base Color */}
      <div className="f-row" data-testid="mat-baseColor">
        <span className="f-name">Base Color</span>
        <span className="f-val">
          <input
            type="color"
            value={linearToSrgbHex(baseColor)}
            onChange={handleColorChange}
            disabled={!canEdit}
            data-testid="mat-baseColor-input"
            style={{ width: 32, height: 22, border: 'none', padding: 0, cursor: canEdit ? 'pointer' : 'default' }}
          />
          <span className="hexval" style={{ marginLeft: 6, fontSize: '0.82em', fontFamily: 'monospace' }}>
            {linearToSrgbHex(baseColor)}
          </span>
        </span>
      </div>

      {/* Metallic */}
      <div className="f-row" data-testid="mat-metallic">
        <span className="f-name">Metallic</span>
        <span className="f-val">
          <input
            type="range"
            min={0} max={1} step={0.01}
            value={localMetallic}
            onChange={(e) => setLocalMetallic(Number(e.target.value))}
            onMouseUp={() => handleMetallicCommit(localMetallic)}
            onKeyUp={() => handleMetallicCommit(localMetallic)}
            disabled={!canEdit}
            data-testid="mat-metallic-slider"
            style={{ width: '60%' }}
          />
          <span style={{ marginLeft: 6, fontSize: '0.85em', minWidth: 30 }}>{localMetallic.toFixed(2)}</span>
        </span>
      </div>

      {/* Roughness */}
      <div className="f-row" data-testid="mat-roughness">
        <span className="f-name">Roughness</span>
        <span className="f-val">
          <input
            type="range"
            min={0} max={1} step={0.01}
            value={localRoughness}
            onChange={(e) => setLocalRoughness(Number(e.target.value))}
            onMouseUp={() => handleRoughnessCommit(localRoughness)}
            onKeyUp={() => handleRoughnessCommit(localRoughness)}
            disabled={!canEdit}
            data-testid="mat-roughness-slider"
            style={{ width: '60%' }}
          />
          <span style={{ marginLeft: 6, fontSize: '0.85em', minWidth: 30 }}>{localRoughness.toFixed(2)}</span>
        </span>
      </div>

      {/* Passes (read-only) */}
      <PropertyRow label="Passes" value={passes.length} />
      {passes.map((p, i) => (
        <PropertyRow key={i} label={`  Pass ${i}`} value={`${p.name ?? '?'} → ${p.program?.module ?? '?'}`} />
      ))}

      {parent && <PropertyRow label="Parent" value={parent} />}

      {/* Texture slots (AC-T1 browse + AC-T2 drop + AC-T3 empty state) */}
      <div className="mat-tex-section">
        <div className="mat-tex-section-title">Textures</div>
        {textureFields.map(({ key, guid }) => (
          <TextureSlot
            key={key}
            label={key}
            guid={guid}
            canEdit={canEdit}
            onAssign={(textureGuid) => handleAssignTexture(key, textureGuid)}
            onClear={() => handleClearTexture(key)}
            onBrowse={() => setPickerTarget(key)}
          />
        ))}
      </div>

      {/* AssetPicker modal (AC-T1: Browse → pick → assign) */}
      {pickerTarget && (
        <AssetPicker
          assetType="TextureAsset"
          currentGuid={textureFields.find(f => f.key === pickerTarget)?.guid ?? undefined}
          onPick={(guid) => { handleAssignTexture(pickerTarget, guid); setPickerTarget(null); }}
          onClear={() => { handleClearTexture(pickerTarget); setPickerTarget(null); }}
          onClose={() => setPickerTarget(null)}
        />
      )}
    </div>
  );
}
