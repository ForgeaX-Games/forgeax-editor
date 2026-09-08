import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import {
  deriveMaterialParamRows,
  ensureMaterialChainCataloged,
  gateway,
  getMaterialStaging,
  hexToMaterialColor,
  isMaterialStagingDirty,
  materialCatalogLookup,
  materialColorToHex,
  openMaterialStaging,
  patchMaterialStagingParam,
  resetMaterialStagingParam,
  resolveMaterialParamSchema,
  resolveOverrides,
  setMaterialPreviewParam,
  subscribeMaterialStaging,
  useActiveEditorAsset,
  type MaterialParamRow,
} from '@forgeax/editor-core';
import { ForgeaxIcon } from '@forgeax/editor-ui';
import { AssetPicker, anchorFromElement, type AssetPickerAnchor } from '../AssetPicker';
import { PropertyRow } from './PropertyRow';
import { useNumberDraft } from '../useNumberDraft';
import { materialRenderStateFacts } from './material-render-state-facts';
import {
  getMaterialCategoryCollapsed,
  registerMaterialCategoryIds,
  subscribeMaterialCategoryState,
  toggleMaterialCategory,
} from './material-category-state';
import { useMaterialFilter, useMaterialToolbarRegistration } from './material-toolbar';
import type { PreviewProps } from './index';
import { inspectorFieldLabel } from '../inspector-field-label';
import { AssetRefControl } from '../AssetRefControl';

interface PassDesc {
  name?: string;
  program?: { module?: string };
}

/** Accepted drag-drop kinds for texture assignment. */
const DROPPABLE_TEXTURE_KINDS: ReadonlySet<string> = new Set(['texture', 'image']);

// ── TextureSlot: per-field drop zone + browse + display ─────────────────────

interface TextureSlotProps {
  label: string;
  guid: string | null;
  canEdit: boolean;
  onAssign: (textureGuid: string) => void;
  onClear: () => void;
  onBrowse: (anchor: AssetPickerAnchor) => void;
}

function TextureSlot({ label, guid, canEdit, onAssign, onClear, onBrowse }: TextureSlotProps) {
  return (
    <div className="f-row" data-testid={`mat-${label}`}>
      <span className="f-name" title={label}>{inspectorFieldLabel(label)}</span>
      <span className="f-val">
        <AssetRefControl
          assetType="TextureAsset"
          guid={guid}
          testId={`mat-${label}`}
          readOnly={!canEdit}
          onBrowse={onBrowse}
          onBind={(nextGuid) => {
            const entry = gateway.assetCatalog().find((row) => row.guid === nextGuid);
            if (!entry || !DROPPABLE_TEXTURE_KINDS.has(entry.kind)) return;
            onAssign(nextGuid);
          }}
          onClear={onClear}
        />
      </span>
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
 *  aborts, arrows step) shared by scalar and vector editors. Renders the same
 *  `.numfield` widget as the entity Inspector: a centred `.box-i` input with a
 *  hover/focus stepper, plus an optional axis class for the vec colour underline. */
function NumberCell({ value, canEdit, onCommit, testId, axisClass, wrapClass }: {
  value: number;
  canEdit: boolean;
  onCommit: (n: number) => void;
  testId?: string;
  axisClass?: string;
  wrapClass?: string;
}) {
  const draft = useNumberDraft(value, undefined, onCommit);
  const step = (dir: 1 | -1) => onCommit(Math.round((value + dir * 0.1) * 1e4) / 1e4);
  return (
    <span className={`numfield${wrapClass ? ` ${wrapClass}` : ''}`}>
      <input
        type="text"
        inputMode="decimal"
        className={`box-i${axisClass ? ` ${axisClass}` : ''}`}
        disabled={!canEdit}
        data-testid={testId}
        value={draft.value}
        onFocus={draft.onFocus}
        onChange={draft.onChange}
        onBlur={draft.onBlur}
        onKeyDown={draft.onKeyDown}
      />
      {canEdit && (
        <span className="nspin" aria-hidden>
          <button type="button" tabIndex={-1} className="nsp up" onPointerDown={(e) => { e.preventDefault(); step(1); }}>
            <ForgeaxIcon name="chevronUp" size={9} />
          </button>
          <button type="button" tabIndex={-1} className="nsp dn" onPointerDown={(e) => { e.preventDefault(); step(-1); }}>
            <ForgeaxIcon name="chevronDown" size={9} />
          </button>
        </span>
      )}
    </span>
  );
}

function ScalarEditor({ row, canEdit, onCommit, onPreview }: EditorProps) {
  const display = typeof row.value === 'number' ? row.value : 0;
  const [drag, setDrag] = useState<number | null>(null);
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
        wrapClass="num"
      />
    </span>
  );
}

function ColorEditor({ row, canEdit, onCommit, onPreview }: EditorProps) {
  const arr = Array.isArray(row.value) ? row.value as number[]
    : Array.isArray(row.defaultValue) ? row.defaultValue as number[]
    : [1, 1, 1, 1];
  const hex = materialColorToHex(arr, row.colorSpace);
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
        className="swatch"
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
        style={canEdit ? undefined : { cursor: 'default' }}
      />
      <span className="hexval">{shown}</span>
    </span>
  );
}

function VectorEditor({ row, canEdit, onCommit }: EditorProps) {
  const count = row.components;
  const current = (Array.isArray(row.value) ? row.value as number[] : [0, 0, 0, 0]).slice(0, count);

  const updateComponent = (index: number, next: number) => {
    const nextArr = [...current];
    while (nextArr.length < count) nextArr.push(0);
    nextArr[index] = next;
    onCommit(nextArr);
  };

  const axes = ['x', 'y', 'z', 'w'];

  return (
    <span className="f-val">
      <span className="vec">
        {Array.from({ length: count }, (_, i) => (
          <span className="vcell" key={i}>
            <NumberCell
              value={current[i] ?? 0}
              canEdit={canEdit}
              onCommit={(n) => updateComponent(i, n)}
              testId={`mat-${row.name}-${axes[i]}`}
              axisClass={axes[i]}
            />
          </span>
        ))}
      </span>
    </span>
  );
}

function BoolEditor({ row, canEdit, onCommit }: EditorProps) {
  const checked = Boolean(row.value ?? row.defaultValue ?? false);
  return (
    <span className="f-val">
      <input
        type="checkbox"
        checked={checked}
        disabled={!canEdit}
        data-testid={`mat-${row.name}-check`}
        onChange={(e) => onCommit(e.target.checked)}
      />
    </span>
  );
}

// ── Categories & Grouping ───────────────────────────────────────────────────

interface CategoryDef {
  id: string;
  title: string;
  /** Left-border accent dimension, mirrors the entity Inspector's
   *  dim-type (brand) / dim-all (teal) / dim-cap (amber) colour blocks. */
  dim: 'type' | 'all' | 'cap';
  match: (name: string) => boolean;
}

const CATEGORY_DEFS: CategoryDef[] = [
  {
    id: 'baseColor',
    title: 'Base Color',
    dim: 'type',
    match: (n) => /(baseColor|albedo|diffuse|color(?!space))/i.test(n),
  },
  {
    id: 'metallicRoughness',
    title: 'Metallic & Roughness',
    dim: 'cap',
    match: (n) => !/(channel)/i.test(n) && /(metallic|roughness|specular|glossiness)/i.test(n),
  },
  {
    id: 'normal',
    title: 'Normal & Bump',
    dim: 'all',
    match: (n) => /(normal|bump|height|displacement)/i.test(n),
  },
  {
    id: 'occlusion',
    title: 'Ambient Occlusion',
    dim: 'type',
    match: (n) => !/(channel)/i.test(n) && /(occlusion|\bao\b|ambientOcclusion)/i.test(n),
  },
  {
    id: 'emissive',
    title: 'Emissive & Glow',
    dim: 'cap',
    match: (n) => /(emissive|glow)/i.test(n),
  },
  {
    id: 'uv',
    title: 'UV & Tiling',
    dim: 'all',
    match: (n) => /(uv|tile|tiling|offset|repeat|st\b)/i.test(n),
  },
  {
    id: 'advanced',
    title: 'Advanced',
    dim: 'type',
    match: () => true,
  },
];

// ── Main component ──────────────────────────────────────────────────────────

export default function AssetPreviewMaterial({ payload: propsPayload }: PreviewProps): ReactElement {
  const asset = useActiveEditorAsset();
  const [version, setVersion] = useState(0);
  const [chainVersion, setChainVersion] = useState(0);
  const [pickerTarget, setPickerTarget] = useState<{ name: string; anchor: AssetPickerAnchor } | null>(null);
  // Collapse state is shared UI chrome hoisted to a module store so the
  // panel-header Expand All / Collapse All commands can drive it (see
  // material-category-state).
  const collapsed = useSyncExternalStore(
    subscribeMaterialCategoryState,
    getMaterialCategoryCollapsed,
    getMaterialCategoryCollapsed,
  );
  // Parameter search now lives in the panel-header action row (a self-registered
  // `control`); its text is shared through the material-toolbar module store.
  const filterText = useMaterialFilter();
  useMaterialToolbarRegistration();

  // Subscribe to staging changes
  useEffect(() => {
    return subscribeMaterialStaging(() => setVersion((v) => v + 1));
  }, []);

  // Initialize staging buffer
  useEffect(() => {
    if (!asset || asset.kind !== 'material') return;
    openMaterialStaging({
      guid: asset.guid,
      packPath: asset.packPath,
      name: asset.name,
      payload: asset.payload ?? propsPayload,
    });
  }, [asset?.guid, asset?.packPath, asset?.name, propsPayload]);

  // Parent-chain warm
  useEffect(() => {
    if (!asset?.guid) return;
    let cancelled = false;
    void ensureMaterialChainCataloged(gateway.doc.registry, asset.guid).then(() => {
      if (!cancelled) setChainVersion((v) => v + 1);
    });
    return () => { cancelled = true; };
  }, [asset?.guid]);

  const stagingEntry = asset?.guid ? getMaterialStaging(asset.guid) : undefined;
  const rawPayload = (stagingEntry?.staging ?? propsPayload) as Record<string, unknown>;
  const materialReadiness = asset?.guid
    ? gateway.doc.registry?.getMaterialReadiness(asset.guid)
    : undefined;
  const inspectionPayload = materialReadiness?.status === 'Ready'
    ? { ...rawPayload, parameterContract: materialReadiness.parameterContract }
    : rawPayload;
  const parameterContract = inspectionPayload.parameterContract;
  const cookedValues = parameterContract !== null
    && typeof parameterContract === 'object'
    && !Array.isArray(parameterContract)
    ? (parameterContract as { values?: unknown }).values
    : undefined;
  const ownValues = (stagingEntry?.staging.values
    ?? (cookedValues as Record<string, unknown> | undefined)
    ?? (propsPayload.values as Record<string, unknown>)
    ?? {}) as Record<string, unknown>;
  const passes = Array.isArray(rawPayload.passes) ? (rawPayload.passes as PassDesc[]) : [];
  const parent = rawPayload.parent as string | undefined;
  const colorSpace = rawPayload.colorSpace === 'linear' ? 'linear' : 'srgb';
  const isDirty = asset?.guid ? isMaterialStagingDirty(asset.guid) : false;

  const catalogEntry = useMemo(() => {
    if (!asset?.guid) return undefined;
    return gateway.assetCatalog().find((e) => e.guid === asset.guid);
  }, [asset?.guid, version]);
  const refs = catalogEntry?.refs ?? [];

  const resolvedValues = useMemo(() => {
    void chainVersion;
    void version;
    if (!asset?.guid) return ownValues;
    const resolved = resolveOverrides(asset.guid, materialCatalogLookup(gateway.doc.registry));
    return Object.keys(resolved).length > 0 ? { ...resolved, ...ownValues } : ownValues;
  }, [asset?.guid, ownValues, chainVersion, version]);

  const { descriptors, declaredNames } = useMemo(
    () => resolveMaterialParamSchema(inspectionPayload, undefined),
    [inspectionPayload],
  );

  const rows = useMemo(() => deriveMaterialParamRows({
    descriptors,
    declaredNames,
    ownValues,
    resolvedValues,
    refs,
    colorSpace,
  }), [descriptors, declaredNames, ownValues, resolvedValues, refs, colorSpace]);

  const canEdit = !!asset?.packPath && !!asset?.guid;
  const surface = materialRenderStateFacts(rawPayload);

  // Staging commit helper
  const commitParam = useCallback((name: string, value: unknown) => {
    if (!asset?.guid) return;
    patchMaterialStagingParam(asset.guid, { [name]: value });
    setMaterialPreviewParam(asset.guid, name, value);
  }, [asset?.guid]);

  const previewParam = useCallback((name: string, value: unknown) => {
    if (asset?.guid) setMaterialPreviewParam(asset.guid, name, value);
  }, [asset?.guid]);

  const resetParam = useCallback((name: string, defaultValue?: unknown) => {
    if (!asset?.guid) return;
    resetMaterialStagingParam(asset.guid, name, defaultValue);
    setMaterialPreviewParam(asset.guid, name, undefined);
  }, [asset?.guid]);

  const handleAssignTexture = useCallback((key: string, textureGuid: string) => {
    if (!asset?.guid) return;
    patchMaterialStagingParam(asset.guid, {}, { [key]: textureGuid });
    setMaterialPreviewParam(asset.guid, key, textureGuid);
  }, [asset?.guid]);

  const handleClearTexture = useCallback((key: string) => {
    if (!asset?.guid) return;
    patchMaterialStagingParam(asset.guid, { [key]: undefined }, { [key]: null });
    setMaterialPreviewParam(asset.guid, key, undefined);
  }, [asset?.guid]);

  // Filter and group rows
  const filteredRows = useMemo(() => {
    if (!filterText.trim()) return rows;
    const q = filterText.toLowerCase();
    return rows.filter((r) => r.name.toLowerCase().includes(q) || inspectorFieldLabel(r.name).toLowerCase().includes(q));
  }, [rows, filterText]);

  const groupedCategories = useMemo(() => {
    const map = new Map<string, { def: CategoryDef; paramRows: MaterialParamRow[]; textureRows: MaterialParamRow[] }>();
    for (const def of CATEGORY_DEFS) {
      map.set(def.id, { def, paramRows: [], textureRows: [] });
    }

    for (const row of filteredRows) {
      let matchedDef = CATEGORY_DEFS.find((d) => d.id !== 'advanced' && d.match(row.name));
      if (!matchedDef) matchedDef = CATEGORY_DEFS.find((d) => d.id === 'advanced')!;
      const group = map.get(matchedDef.id)!;
      if (row.kind === 'texture') {
        group.textureRows.push(row);
      } else {
        group.paramRows.push(row);
      }
    }

    return Array.from(map.values()).filter((g) => g.paramRows.length > 0 || g.textureRows.length > 0);
  }, [filteredRows]);

  // Publish the full collapse universe (fixed Render State + dynamic parameter
  // categories + Passes) so the panel-header Collapse All command can fold every
  // card. Expand/Collapse All themselves are now panelActions commands.
  useEffect(() => {
    registerMaterialCategoryIds(['surface', ...groupedCategories.map(({ def }) => def.id), 'passes']);
  }, [groupedCategories]);

  return (
    <div data-testid="preview-material" className="fx-inspector" data-dirty={isDirty ? '1' : undefined}>
      {/* Surface Render State */}
      <div className={`cat dim-all${collapsed.has('surface') ? ' collapsed' : ''}`} data-testid="mat-render-state">
        <div className="cat-head" onClick={() => toggleMaterialCategory('surface')}>
          <span className="car"><ForgeaxIcon name={collapsed.has('surface') ? 'chevronRight' : 'chevronDown'} size={12} /></span>
          <span className="ct">Render State</span>
        </div>
        {!collapsed.has('surface') && (
          <div className="cat-fields">
            <PropertyRow label="Two Sided" value={surface.twoSided ? 'Yes' : 'No'} />
            <PropertyRow label="Cull Mode" value={surface.cullMode} />
            <PropertyRow label="Blend" value={surface.blendLabel} />
          </div>
        )}
      </div>

      {/* Dynamic Categorized Parameters */}
      {groupedCategories.map(({ def, paramRows, textureRows }) => {
        const isCatCollapsed = collapsed.has(def.id);
        const overriddenCount = [...paramRows, ...textureRows].filter((r) => r.overridden).length;

        return (
          <div key={def.id} className={`cat dim-${def.dim}${isCatCollapsed ? ' collapsed' : ''}`} data-testid={`mat-category-${def.id}`}>
            <div className="cat-head" onClick={() => toggleMaterialCategory(def.id)}>
              <span className="car"><ForgeaxIcon name={isCatCollapsed ? 'chevronRight' : 'chevronDown'} size={12} /></span>
              <span className="ct">{def.title}</span>
              {overriddenCount > 0 && (
                <span className="cat-override-badge" title={`${overriddenCount} properties overridden`}>
                  {overriddenCount}
                </span>
              )}
            </div>

            {!isCatCollapsed && (
              <div className="cat-fields">
                {/* Scalar / Color / Vector / Bool rows */}
                {paramRows.map((row) => (
                  <div
                    className="f-row"
                    data-testid={`mat-${row.name}`}
                    data-overridden={row.overridden ? '1' : undefined}
                    key={row.name}
                  >
                    <span
                      className="f-name"
                      title={row.kind === 'color'
                        ? `${row.name} — stored as ${row.colorSpace === 'srgb' ? 'sRGB; converted to linear once at render extraction' : 'explicit linear RGB'}`
                        : row.name}
                    >
                      {inspectorFieldLabel(row.name)}
                    </span>
                    {row.kind === 'color' && (
                      <ColorEditor
                        row={row}
                        canEdit={canEdit}
                        onCommit={(v) => commitParam(row.name, v)}
                        onPreview={(v) => previewParam(row.name, v)}
                      />
                    )}
                    {row.kind === 'scalar' && (
                      <ScalarEditor
                        row={row}
                        canEdit={canEdit}
                        onCommit={(v) => commitParam(row.name, v)}
                        onPreview={(v) => previewParam(row.name, v)}
                      />
                    )}
                    {row.kind === 'vector' && (
                      <VectorEditor
                        row={row}
                        canEdit={canEdit}
                        onCommit={(v) => commitParam(row.name, v)}
                        onPreview={(v) => previewParam(row.name, v)}
                      />
                    )}
                    {row.kind === 'bool' && (
                      <BoolEditor
                        row={row}
                        canEdit={canEdit}
                        onCommit={(v) => commitParam(row.name, v)}
                        onPreview={(v) => previewParam(row.name, v)}
                      />
                    )}
                    {row.kind === 'readonly' && (
                      <span className="f-val"><span className="hexval">{String(row.value ?? '—')}</span></span>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        className={`reset${row.overridden ? '' : ' hidden'}`}
                        title="Reset to default/inherited"
                        data-testid={`mat-${row.name}-reset`}
                        disabled={!row.overridden}
                        tabIndex={row.overridden ? undefined : -1}
                        aria-hidden={row.overridden ? undefined : true}
                        onClick={() => resetParam(row.name, row.defaultValue)}
                      >
                        <ForgeaxIcon name="reset" size={12} />
                      </button>
                    )}
                  </div>
                ))}

                {/* Texture Slots */}
                {textureRows.map((row) => (
                  <TextureSlot
                    key={row.name}
                    label={row.name}
                    guid={row.textureGuid}
                    canEdit={canEdit}
                    onAssign={(textureGuid) => handleAssignTexture(row.name, textureGuid)}
                    onClear={() => handleClearTexture(row.name)}
                    onBrowse={(anchor) => setPickerTarget({ name: row.name, anchor })}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Passes & Technical Details */}
      <div className={`cat dim-cap${collapsed.has('passes') ? ' collapsed' : ''}`}>
        <div className="cat-head" onClick={() => toggleMaterialCategory('passes')}>
          <span className="car"><ForgeaxIcon name={collapsed.has('passes') ? 'chevronRight' : 'chevronDown'} size={12} /></span>
          <span className="ct">Passes &amp; Technical Details</span>
        </div>
        {!collapsed.has('passes') && (
          <div className="cat-fields">
            <PropertyRow label="Pass Count" value={passes.length} />
            {passes.map((p, i) => (
              <PropertyRow key={i} label={`Pass ${i}`} value={`${p.name ?? '?'} → ${p.program?.module ?? '?'}`} />
            ))}
            {parent && <PropertyRow label="Parent" value={parent} />}
          </div>
        )}
      </div>

      {/* AssetPicker modal for texture assignment */}
      {pickerTarget && (
        <AssetPicker
          assetType="TextureAsset"
          anchor={pickerTarget.anchor}
          currentGuid={rows.find((r) => r.name === pickerTarget.name)?.textureGuid ?? undefined}
          onPick={(guid) => { handleAssignTexture(pickerTarget.name, guid); setPickerTarget(null); }}
          onClear={() => { handleClearTexture(pickerTarget.name); setPickerTarget(null); }}
          onClose={() => setPickerTarget(null)}
        />
      )}
    </div>
  );
}
