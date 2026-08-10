import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deriveMaterialParamRows,
  ensureAssetCataloged,
  ensureMaterialChainCataloged,
  ensureShaderParamSchemaIndex,
  gateway,
  hexToMaterialColor,
  materialCatalogLookup,
  materialColorToHex,
  panelBridge,
  resolveMaterialParamSchema,
  resolveOverrides,
  setMaterialPreviewParam,
  useActiveEditorAsset,
  type MaterialParamRow,
  type ShaderParamSchemaIndex,
} from '@forgeax/editor-core';
import { AssetPicker } from '../AssetPicker';
import { PropertyRow } from './PropertyRow';
import { useNumberDraft } from '../useNumberDraft';
import type { PreviewProps } from './index';

interface PassDesc {
  name?: string;
  program?: { module?: string };
}

/** Accepted drag-drop kinds for texture assignment. */
const DROPPABLE_TEXTURE_KINDS: ReadonlySet<string> = new Set(['texture', 'image']);

/** camelCase schema name → human label ("baseColor" → "Base Color"). The raw
 *  name stays on the tooltip so shader-side naming remains discoverable. */
function paramLabel(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
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

// ── Per-kind parameter editors ──────────────────────────────────────────────

interface EditorProps {
  row: MaterialParamRow;
  canEdit: boolean;
  onCommit: (value: unknown) => void;
  onPreview: (value: unknown) => void;
}

/** Single numeric cell with draft semantics (commit on blur/Enter, Escape
 *  aborts, arrows step) shared by scalar and vector editors. */
function NumberCell({ value, canEdit, onCommit, testId }: {
  value: number;
  canEdit: boolean;
  onCommit: (n: number) => void;
  testId?: string;
}) {
  const draft = useNumberDraft(value, undefined, onCommit);
  return (
    <input
      type="text"
      inputMode="decimal"
      style={{ width: 56 }}
      disabled={!canEdit}
      data-testid={testId}
      value={draft.value}
      onFocus={draft.onFocus}
      onChange={draft.onChange}
      onBlur={draft.onBlur}
      onKeyDown={draft.onKeyDown}
    />
  );
}

function ScalarEditor({ row, canEdit, onCommit, onPreview }: EditorProps) {
  const display = typeof row.value === 'number' ? row.value : 0;
  const [drag, setDrag] = useState<number | null>(null);
  // Optimistic post-commit value: the pack write + assetsChanged round-trip is
  // async, so without this the slider would snap back to the stale value until
  // the write lands. Cleared as soon as the resolved value refreshes.
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => { setPending(null); }, [display]);
  const shown = drag ?? pending ?? display;

  const finishDrag = useCallback(() => {
    if (drag !== null) {
      setPending(drag);
      onCommit(drag);
      setDrag(null);
    }
  }, [drag, onCommit]);

  return (
    <span className="f-val">
      {row.slider && (
        <input
          type="range"
          min={0} max={1} step={0.01}
          value={shown}
          onChange={(e) => {
            const v = Number(e.target.value);
            setDrag(v);
            onPreview(v);
          }}
          onMouseUp={finishDrag}
          onKeyUp={finishDrag}
          disabled={!canEdit}
          data-testid={`mat-${row.name}-slider`}
          style={{ width: '50%' }}
        />
      )}
      <NumberCell
        value={shown}
        canEdit={canEdit}
        onCommit={(n) => { setDrag(null); setPending(n); onCommit(n); }}
        testId={`mat-${row.name}-number`}
      />
    </span>
  );
}

function ColorEditor({ row, canEdit, onCommit, onPreview }: EditorProps) {
  const arr = Array.isArray(row.value) ? row.value as number[]
    : Array.isArray(row.defaultValue) ? row.defaultValue as number[]
    : [1, 1, 1, 1];
  const hex = materialColorToHex(arr, row.colorSpace);
  // The native color input fires `input` per picker tick; route those through
  // the transient preview channel and commit once on blur so a color drag is
  // ONE ledger entry instead of dozens. `pendingHex` keeps the swatch on the
  // committed color until the async pack write round-trips into row.value.
  const picked = useRef<string | null>(null);
  const [pendingHex, setPendingHex] = useState<string | null>(null);
  useEffect(() => { setPendingHex(null); }, [hex]);
  const shown = pendingHex ?? hex;

  const toValue = (nextHex: string): number[] => {
    const alpha = row.components === 4 ? (arr[3] ?? 1) : 1;
    const next = hexToMaterialColor(nextHex, alpha, row.colorSpace);
    return row.components === 4 ? next : next.slice(0, row.components);
  };

  return (
    <span className="f-val">
      <input
        type="color"
        value={shown}
        onChange={(e) => {
          picked.current = e.target.value;
          setPendingHex(e.target.value);
          onPreview(toValue(e.target.value));
        }}
        onBlur={() => {
          if (picked.current !== null && picked.current !== hex) onCommit(toValue(picked.current));
          picked.current = null;
        }}
        disabled={!canEdit}
        data-testid={`mat-${row.name}-input`}
        style={{ width: 32, height: 22, border: 'none', padding: 0, cursor: canEdit ? 'pointer' : 'default' }}
      />
      <span className="hexval" style={{ marginLeft: 6, fontSize: '0.82em', fontFamily: 'monospace' }}>
        {shown}
      </span>
    </span>
  );
}

function VectorEditor({ row, canEdit, onCommit }: EditorProps) {
  const arr = Array.isArray(row.value) ? row.value as number[]
    : Array.isArray(row.defaultValue) ? row.defaultValue as number[]
    : new Array<number>(row.components).fill(0);
  return (
    <span className="f-val" style={{ display: 'inline-flex', gap: 4 }}>
      {Array.from({ length: row.components }, (_, i) => (
        <NumberCell
          key={i}
          value={typeof arr[i] === 'number' ? arr[i]! : 0}
          canEdit={canEdit}
          onCommit={(n) => {
            const next = Array.from({ length: row.components }, (_, j) => (typeof arr[j] === 'number' ? arr[j]! : 0));
            next[i] = n;
            onCommit(next);
          }}
          testId={`mat-${row.name}-${i}`}
        />
      ))}
    </span>
  );
}

function BoolEditor({ row, canEdit, onCommit }: EditorProps) {
  return (
    <span className="f-val">
      <input
        type="checkbox"
        checked={row.value === true}
        disabled={!canEdit}
        onChange={(e) => onCommit(e.target.checked)}
        data-testid={`mat-${row.name}-checkbox`}
      />
    </span>
  );
}

// ── Live payload (unchanged contract: catalog envelope is the SSOT) ─────────

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

// ── Main component ──────────────────────────────────────────────────────────

export default function AssetPreviewMaterial({ payload: propsPayload }: PreviewProps) {
  const asset = useActiveEditorAsset();
  const { payload, refs } = useLivePayload(propsPayload, asset?.guid);
  const [schemaIndex, setSchemaIndex] = useState<ShaderParamSchemaIndex | undefined>(undefined);
  const [chainVersion, setChainVersion] = useState(0);
  const [pickerTarget, setPickerTarget] = useState<string | null>(null);

  // Shader paramSchema index from the same manifest the renderer boots with —
  // the engine SSOT for "which parameters this material's shader exposes".
  useEffect(() => {
    let cancelled = false;
    void ensureShaderParamSchemaIndex().then((index) => {
      if (!cancelled) setSchemaIndex(index);
    });
    return () => { cancelled = true; };
  }, []);

  // Parent-chain warm: resolveOverrides reads registry.assetCatalog
  // synchronously, and only loadByGuid fills it — an uncatalogued parent would
  // silently drop inherited values from every row.
  useEffect(() => {
    if (!asset?.guid) return;
    let cancelled = false;
    void ensureMaterialChainCataloged(gateway.doc.registry, asset.guid).then(() => {
      if (!cancelled) setChainVersion((v) => v + 1);
    });
    return () => { cancelled = true; };
  }, [asset?.guid]);

  const passes = Array.isArray(payload.passes) ? (payload.passes as PassDesc[]) : [];
  const parent = payload.parent as string | undefined;
  const colorSpace = payload.colorSpace === 'linear' ? 'linear' : 'srgb';
  const ownValues = (payload.values ?? {}) as Record<string, unknown>;

  // Display inherited (parent-chain merged) values, not just the material's
  // own — this is what the renderer resolves at draw time.
  const resolvedValues = useMemo(() => {
    void chainVersion;
    if (!asset?.guid) return ownValues;
    const resolved = resolveOverrides(asset.guid, materialCatalogLookup(gateway.doc.registry));
    return Object.keys(resolved).length > 0 ? resolved : ownValues;
  }, [asset?.guid, ownValues, chainVersion]);

  const { descriptors, declaredNames } = useMemo(
    () => resolveMaterialParamSchema(payload, schemaIndex),
    [payload, schemaIndex],
  );

  const rows = useMemo(() => deriveMaterialParamRows({
    descriptors,
    declaredNames,
    ownValues,
    resolvedValues,
    refs,
    colorSpace,
  }), [descriptors, declaredNames, ownValues, resolvedValues, refs, colorSpace]);

  const paramRows = rows.filter((row) => row.kind !== 'texture');
  const textureRows = rows.filter((row) => row.kind === 'texture');

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

  /** Commit one parameter through the ledger. The transient drag overlay is
   *  NOT cleared here — the preview viewport drops it when the post-write
   *  `assetsChanged` re-resolve lands, so the preview never flickers back to
   *  the pre-commit value in between. */
  const commitParam = useCallback((name: string, value: unknown) => {
    dispatchParam({ [name]: value });
  }, [dispatchParam]);

  const previewParam = useCallback((name: string, value: unknown) => {
    if (asset?.guid) setMaterialPreviewParam(asset.guid, name, value);
  }, [asset?.guid]);

  /** Revert one parameter to the inherited/default value by deleting the
   *  material's own key (updateMaterialParams deletes on undefined). */
  const resetParam = useCallback((name: string) => {
    dispatchParam({ [name]: undefined });
  }, [dispatchParam]);

  const handleAssignTexture = useCallback((key: string, textureGuid: string) => {
    if (!asset) return;
    dispatchMaterialOp({ paramPatch: {}, textureGuids: { [key]: textureGuid } });
  }, [asset, dispatchMaterialOp]);

  const handleClearTexture = useCallback((key: string) => {
    dispatchMaterialOp({ paramPatch: { [key]: undefined }, textureGuids: { [key]: null } });
  }, [dispatchMaterialOp]);

  return (
    <div data-testid="preview-material" className="mat-editor">
      <div className="compname">Material</div>

      {/* Schema-driven parameter rows (shader paramSchema + declared +
          values-only), displayed with parent-chain resolved values. */}
      <div className="mat-tex-section">
        <div className="mat-tex-section-title">Parameters</div>
        {paramRows.length === 0 && (
          <div className="field muted">No parameters on this material.</div>
        )}
        {paramRows.map((row) => (
          <div className="f-row" data-testid={`mat-${row.name}`} data-overridden={row.overridden ? '1' : undefined} key={row.name}>
            <span
              className="f-name"
              title={row.kind === 'color'
                ? `${row.name} — stored as ${row.colorSpace === 'srgb' ? 'sRGB; converted to linear once at render extraction' : 'explicit linear RGB; the browser color picker is displayed in sRGB'}`
                : row.name}
            >
              {paramLabel(row.name)}
            </span>
            {row.kind === 'color' && (
              <ColorEditor row={row} canEdit={canEdit}
                onCommit={(v) => commitParam(row.name, v)} onPreview={(v) => previewParam(row.name, v)} />
            )}
            {row.kind === 'scalar' && (
              <ScalarEditor row={row} canEdit={canEdit}
                onCommit={(v) => commitParam(row.name, v)} onPreview={(v) => previewParam(row.name, v)} />
            )}
            {row.kind === 'vector' && (
              <VectorEditor row={row} canEdit={canEdit}
                onCommit={(v) => commitParam(row.name, v)} onPreview={(v) => previewParam(row.name, v)} />
            )}
            {row.kind === 'bool' && (
              <BoolEditor row={row} canEdit={canEdit}
                onCommit={(v) => commitParam(row.name, v)} onPreview={(v) => previewParam(row.name, v)} />
            )}
            {row.kind === 'readonly' && (
              <span className="f-val"><span className="hexval">{String(row.value ?? '—')}</span></span>
            )}
            {canEdit && row.overridden && (
              <button
                className="mat-clear-btn"
                title="Reset to inherited/default"
                data-testid={`mat-${row.name}-reset`}
                onClick={() => resetParam(row.name)}
              >
                ↺
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Texture slots: every texture the shader schema declares (plus
          values-only texture keys), not a hard-coded subset. */}
      <div className="mat-tex-section">
        <div className="mat-tex-section-title">Textures</div>
        {textureRows.length === 0 && (
          <div className="field muted">This material's shader declares no texture slots.</div>
        )}
        {textureRows.map((row) => (
          <TextureSlot
            key={row.name}
            label={row.name}
            guid={row.textureGuid}
            canEdit={canEdit}
            onAssign={(textureGuid) => handleAssignTexture(row.name, textureGuid)}
            onClear={() => handleClearTexture(row.name)}
            onBrowse={() => setPickerTarget(row.name)}
          />
        ))}
      </div>

      {/* Passes (read-only) */}
      <PropertyRow label="Passes" value={passes.length} />
      {passes.map((p, i) => (
        <PropertyRow key={i} label={`  Pass ${i}`} value={`${p.name ?? '?'} → ${p.program?.module ?? '?'}`} />
      ))}

      {parent && <PropertyRow label="Parent" value={parent} />}

      {/* AssetPicker modal (Browse → pick → assign) */}
      {pickerTarget && (
        <AssetPicker
          assetType="TextureAsset"
          currentGuid={textureRows.find((r) => r.name === pickerTarget)?.textureGuid ?? undefined}
          onPick={(guid) => { handleAssignTexture(pickerTarget, guid); setPickerTarget(null); }}
          onClear={() => { handleClearTexture(pickerTarget); setPickerTarget(null); }}
          onClose={() => setPickerTarget(null)}
        />
      )}
    </div>
  );
}
