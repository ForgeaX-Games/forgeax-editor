import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  ensureAssetCataloged,
  gateway,
  hexToMaterialColor,
  materialColorToHex,
  panelBridge,
} from '@forgeax/editor-core';
import type { SelectedAsset } from '@forgeax/editor-core';
import { AssetPicker } from './AssetPicker';
import { PropertyRow } from './asset-inspector/PropertyRow';
import './inspector.css';

interface PassDesc {
  name?: string;
  program?: { module?: string };
}

const TEXTURE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
]);

const DROPPABLE_TEXTURE_KINDS: ReadonlySet<string> = new Set(['texture', 'image']);

function resolveTextureGuid(value: unknown, refs: readonly string[]): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && refs[value]) return refs[value]!;
  return null;
}

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
  const handleDragLeave = useCallback(() => setDropHot(false), []);
  const handleDragOver = useCallback((e: React.DragEvent) => e.preventDefault(), []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDropHot(false);
    const json = e.dataTransfer.getData('application/x-forgeax-asset');
    if (!json) return;
    try {
      const ref = JSON.parse(json) as { guid?: string; kind?: string };
      if (!ref.guid || !DROPPABLE_TEXTURE_KINDS.has(ref.kind ?? '')) return;
      onAssign(ref.guid);
    } catch { /* malformed drag payload */ }
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
            <button className="mat-clear-btn" title="Clear texture" onClick={onClear}>✕</button>
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

interface CatalogRow {
  guid: string;
  name: string;
  kind: string;
  packPath: string;
  refs?: readonly string[];
}

function useMaterialCatalog(): CatalogRow[] {
  const [version, setVersion] = useState(0);
  useEffect(() => panelBridge.on('assetsChanged', () => setVersion((v) => v + 1)), []);

  return useMemo(() => {
    void version;
    const catalog = gateway.assetCatalog() as unknown as CatalogRow[];
    return catalog.filter((row) => row.kind === 'material');
  }, [version]);
}

function useLivePayload(guid: string | undefined): {
  payload: Record<string, unknown>;
  refs: readonly string[];
} {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!guid) return;
    return panelBridge.on('assetsChanged', () => setVersion((v) => v + 1));
  }, [guid]);

  useEffect(() => {
    if (!guid || gateway.lookupAsset(guid) !== undefined) return;
    let cancelled = false;
    void ensureAssetCataloged(gateway.doc.registry, guid).then((loaded) => {
      if (loaded && !cancelled) setVersion((v) => v + 1);
    });
    return () => { cancelled = true; };
  }, [guid, version]);

  return useMemo(() => {
    void version;
    if (!guid) return { payload: {}, refs: [] };
    const live = gateway.lookupAsset(guid) as Record<string, unknown> | undefined;
    const catalog = gateway.assetCatalog() as unknown as CatalogRow[];
    const entry = catalog.find((e) => e.guid === guid);
    return { payload: live ?? {}, refs: entry?.refs ?? [] };
  }, [guid, version]);
}

export function MaterialEditorPanel(): ReactElement {
  const materials = useMaterialCatalog();
  const [selectedGuid, setSelectedGuid] = useState<string | null>(null);

  const selected = useMemo(
    () => materials.find((m) => m.guid === selectedGuid) ?? null,
    [materials, selectedGuid],
  );

  useEffect(() => {
    if (selectedGuid && !selected && materials.length > 0) {
      setSelectedGuid(materials[0]!.guid);
    }
  }, [selectedGuid, selected, materials]);

  const { payload, refs } = useLivePayload(selected?.guid);

  const passes = Array.isArray(payload.passes) ? (payload.passes as PassDesc[]) : [];
  const parent = payload.parent as string | undefined;
  const values = (payload.values ?? {}) as Record<string, unknown>;
  const colorSpace = payload.colorSpace === 'linear' ? 'linear' : 'srgb';

  const baseColor = Array.isArray(values.baseColor) ? values.baseColor as number[] : [1, 1, 1, 1];
  const metallic = typeof values.metallic === 'number' ? values.metallic : 0;
  const roughness = typeof values.roughness === 'number' ? values.roughness : 0.5;

  const [localMetallic, setLocalMetallic] = useState(metallic);
  const [localRoughness, setLocalRoughness] = useState(roughness);
  const [pickerTarget, setPickerTarget] = useState<string | null>(null);

  useEffect(() => { setLocalMetallic(metallic); }, [metallic]);
  useEffect(() => { setLocalRoughness(roughness); }, [roughness]);

  const canEdit = !!selected?.packPath && !!selected?.guid;

  const dispatchMaterialOp = useCallback((op: {
    paramPatch: Record<string, unknown>;
    textureGuids?: Record<string, string | null>;
  }) => {
    if (!selected) return;
    void (async () => {
      await ensureAssetCataloged(gateway.doc.registry, selected.guid);
      gateway.dispatch({
        kind: 'updateMaterialParams',
        packPath: selected.packPath,
        guid: selected.guid,
        ...op,
      }, 'human');
    })();
  }, [selected]);

  const dispatchParam = useCallback(
    (paramPatch: Record<string, unknown>) => dispatchMaterialOp({ paramPatch }),
    [dispatchMaterialOp],
  );

  const handleAssignTexture = useCallback((key: string, textureGuid: string) => {
    if (!selected) return;
    dispatchMaterialOp({ paramPatch: {}, textureGuids: { [key]: textureGuid } });
  }, [selected, dispatchMaterialOp]);

  const handleClearTexture = useCallback((key: string) => {
    dispatchMaterialOp({ paramPatch: { [key]: undefined }, textureGuids: { [key]: null } });
  }, [dispatchMaterialOp]);

  const handleColorChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const hex = e.target.value;
    const alpha = baseColor[3] ?? 1;
    dispatchParam({ baseColor: hexToMaterialColor(hex, alpha, colorSpace) });
  }, [dispatchParam, baseColor, colorSpace]);

  const handleMetallicCommit = useCallback(
    (val: number) => dispatchParam({ metallic: val }),
    [dispatchParam],
  );

  const handleRoughnessCommit = useCallback(
    (val: number) => dispatchParam({ roughness: val }),
    [dispatchParam],
  );

  const textureFields = useMemo(
    () => [...TEXTURE_FIELD_NAMES].map((key) => ({
      key,
      guid: resolveTextureGuid(values[key], refs),
    })),
    [values, refs],
  );

  if (materials.length === 0) {
    return (
      <div className="panel" data-testid="panel-material-editor">
        <div className="compname">Material Editor</div>
        <div className="field muted">No material assets found in the project.</div>
      </div>
    );
  }

  return (
    <div className="panel" data-testid="panel-material-editor">
      <div className="compname">Material Editor</div>

      {/* Asset selector */}
      <div className="f-row">
        <span className="f-name">Asset</span>
        <select
          className="f-val"
          value={selectedGuid ?? ''}
          onChange={(e) => setSelectedGuid(e.target.value || null)}
          style={{ maxWidth: 200 }}
        >
          <option value="">— Select —</option>
          {materials.map((m) => (
            <option key={m.guid} value={m.guid}>{m.name}</option>
          ))}
        </select>
      </div>

      {!selected ? (
        <div className="field muted" style={{ marginTop: 12 }}>
          Select a material asset above to edit its properties.
        </div>
      ) : Object.keys(payload).length === 0 ? (
        <div className="field muted" style={{ marginTop: 12 }}>Loading material data…</div>
      ) : (
        <div data-testid="material-editor-body" style={{ marginTop: 8 }}>
          {/* Base Color */}
          <div className="f-row" data-testid="mat-baseColor">
            <span className="f-name" title={colorSpace === 'srgb' ? 'Stored as sRGB' : 'Stored as linear RGB'}>
              Base Color ({colorSpace === 'srgb' ? 'sRGB' : 'Linear'})
            </span>
            <span className="f-val">
              <input
                type="color"
                value={materialColorToHex(baseColor, colorSpace)}
                onChange={handleColorChange}
                disabled={!canEdit}
                style={{ width: 32, height: 22, border: 'none', padding: 0, cursor: canEdit ? 'pointer' : 'default' }}
              />
              <span style={{ marginLeft: 6, fontSize: '0.82em', fontFamily: 'monospace' }}>
                {materialColorToHex(baseColor, colorSpace)}
              </span>
            </span>
          </div>

          {/* Metallic */}
          <div className="f-row" data-testid="mat-metallic">
            <span className="f-name">Metallic</span>
            <span className="f-val">
              <input
                type="range" min={0} max={1} step={0.01}
                value={localMetallic}
                onChange={(e) => setLocalMetallic(Number(e.target.value))}
                onMouseUp={() => handleMetallicCommit(localMetallic)}
                onKeyUp={() => handleMetallicCommit(localMetallic)}
                disabled={!canEdit}
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
                type="range" min={0} max={1} step={0.01}
                value={localRoughness}
                onChange={(e) => setLocalRoughness(Number(e.target.value))}
                onMouseUp={() => handleRoughnessCommit(localRoughness)}
                onKeyUp={() => handleRoughnessCommit(localRoughness)}
                disabled={!canEdit}
                style={{ width: '60%' }}
              />
              <span style={{ marginLeft: 6, fontSize: '0.85em', minWidth: 30 }}>{localRoughness.toFixed(2)}</span>
            </span>
          </div>

          {/* Passes */}
          <PropertyRow label="Passes" value={passes.length} />
          {passes.map((p, i) => (
            <PropertyRow key={i} label={`  Pass ${i}`} value={`${p.name ?? '?'} → ${p.program?.module ?? '?'}`} />
          ))}
          {parent && <PropertyRow label="Parent" value={parent} />}

          {/* Textures */}
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

          {pickerTarget && (
            <AssetPicker
              assetType="TextureAsset"
              currentGuid={textureFields.find((f) => f.key === pickerTarget)?.guid ?? undefined}
              onPick={(guid) => { handleAssignTexture(pickerTarget, guid); setPickerTarget(null); }}
              onClear={() => { handleClearTexture(pickerTarget); setPickerTarget(null); }}
              onClose={() => setPickerTarget(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
