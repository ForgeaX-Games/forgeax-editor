// MaterialInstanceEditor — MI properties panel (M3 + M4 staging / Save Sibling|Child).
//
// Edits mutate the per-GUID staging buffer; PageController.save flushes via
// saveMaterialInstance. Save Sibling/Child mint a new MI and open its tab.

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  ensureAssetCataloged,
  ensureMaterialChainCataloged,
  gateway,
  generateAssetGuid,
  getInheritedValue,
  getMiStaging,
  hexToMaterialColor,
  isMaterialInstancePayload,
  materialCatalogLookup,
  materialColorToHex,
  openMiStaging,
  resolveOverrides,
  SURFACE_PARAM_KEYS,
  subscribeMiStaging,
  updateMiStaging,
  useActiveEditorAsset,
  wouldCreateParentCycle,
  type MaterialInstanceLightmass,
  type MaterialInstanceOverride,
  type MaterialInstancePayload,
} from '@forgeax/editor-core';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { ForgeaxIcon, prompt as promptDialog } from '@forgeax/editor-ui';
import { AssetPicker } from '../AssetPicker';
import { OverrideFieldRow } from './OverrideFieldRow';

type GroupId = 'surface' | 'general' | 'lightmass' | 'propertyOverrides';

function asMi(payload: Record<string, unknown> | undefined): MaterialInstancePayload | null {
  return payload && isMaterialInstancePayload(payload) ? payload : null;
}

function enabledOverridesOnly(
  overrides: Readonly<Record<string, MaterialInstanceOverride>>,
): Record<string, MaterialInstanceOverride> {
  const out: Record<string, MaterialInstanceOverride> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value.enabled) out[key] = { enabled: true, ...(value.value !== undefined ? { value: value.value } : {}) };
  }
  return out;
}

export function MaterialInstanceEditor(): ReactElement {
  const { t } = useTranslation();
  const asset = useActiveEditorAsset();
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<GroupId>>(new Set(['propertyOverrides']));
  const [picker, setPicker] = useState<'parent' | 'phys' | null>(null);
  const [localMetallic, setLocalMetallic] = useState<number | null>(null);
  const [localRoughness, setLocalRoughness] = useState<number | null>(null);

  useEffect(() => subscribeMiStaging(() => setVersion((v) => v + 1)), []);
  useEffect(() => {
    if (!asset || asset.kind !== 'material-instance') return;
    const entry = openMiStaging({
      guid: asset.guid,
      packPath: asset.packPath,
      name: asset.name,
      payload: asset.payload,
    });
    let cancelled = false;
    const bump = () => { if (!cancelled) setVersion((v) => v + 1); };
    // Inherited/resolved values read registry.assetCatalog synchronously, and
    // only loadByGuid fills it — catalog this MI AND its whole parent chain or
    // every field falls back to its hard-coded default.
    void ensureAssetCataloged(gateway.doc.registry, asset.guid).then(bump);
    void ensureMaterialChainCataloged(gateway.doc.registry, entry.staging).then(bump);
    return () => { cancelled = true; };
  }, [asset?.guid, asset?.packPath, asset?.name, asset?.kind]);

  const livePayload = useMemo(() => {
    void version;
    if (!asset || asset.kind !== 'material-instance') return null;
    return getMiStaging(asset.guid)?.staging ?? asMi(asset.payload);
  }, [asset, version]);

  const lookup = useMemo(() => materialCatalogLookup(gateway.doc.registry), [version]);
  const inherited = useMemo(() => {
    if (!livePayload) return {} as Record<string, unknown>;
    return {
      baseColor: getInheritedValue(livePayload, 'baseColor', lookup),
      metallic: getInheritedValue(livePayload, 'metallic', lookup),
      roughness: getInheritedValue(livePayload, 'roughness', lookup),
    };
  }, [livePayload, lookup]);

  const resolved = useMemo(
    () => (livePayload ? resolveOverrides(livePayload, lookup) : {}),
    [livePayload, lookup],
  );

  const packPath = asset?.packPath ?? '';
  const guid = asset?.guid ?? '';

  const patchOverride = useCallback((
    paramKey: string,
    enabled: boolean,
    value?: unknown,
    bucket: 'overrides' | 'propertyOverrides' = 'overrides',
  ) => {
    if (!guid) return;
    updateMiStaging(guid, (staging) => {
      const nextEntry: MaterialInstanceOverride = enabled
        ? { enabled: true, ...(value !== undefined ? { value } : {}) }
        : { enabled: false };
      if (bucket === 'propertyOverrides') {
        return {
          ...staging,
          propertyOverrides: { ...(staging.propertyOverrides ?? {}), [paramKey]: nextEntry },
        };
      }
      return {
        ...staging,
        overrides: { ...staging.overrides, [paramKey]: nextEntry },
      };
    });
  }, [guid]);

  const patchLightmass = useCallback((lightmassPatch: Partial<MaterialInstanceLightmass>) => {
    if (!guid) return;
    updateMiStaging(guid, (staging) => ({
      ...staging,
      lightmass: { ...staging.lightmass, ...lightmassPatch },
    }));
  }, [guid]);

  const patchParent = useCallback((parentGuid: string) => {
    if (!guid) return;
    if (wouldCreateParentCycle(guid, parentGuid, materialCatalogLookup(gateway.doc.registry))) return;
    updateMiStaging(guid, (staging) => ({ ...staging, parent: parentGuid }));
    void ensureMaterialChainCataloged(gateway.doc.registry, parentGuid).then(() => setVersion((v) => v + 1));
  }, [guid]);

  const saveAsRelated = useCallback(async (mode: 'sibling' | 'child') => {
    if (!asset || !livePayload || !packPath || !guid) return;
    const defaultName = mode === 'sibling'
      ? `MI_${asset.name.replace(/^MI_/u, '')}_Sibling`
      : `MI_${asset.name.replace(/^MI_/u, '')}_Child`;
    const name = (await promptDialog({
      title: t(mode === 'sibling' ? 'editor.materialInstance.saveSibling' : 'editor.materialInstance.saveChild'),
      label: t('editor.materialInstance.nameLabel'),
      defaultValue: defaultName.startsWith('MI_') ? defaultName : `MI_${defaultName}`,
      confirmText: t('editor.materialInstance.createConfirm'),
      cancelText: t('editor.materialInstance.cancel'),
    }))?.trim();
    if (!name) return;

    const newGuid = generateAssetGuid();
    const parentGuid = mode === 'sibling' ? livePayload.parent : guid;
    const overrides = mode === 'sibling' ? enabledOverridesOnly(livePayload.overrides) : {};
    const createResult = gateway.dispatch({
      kind: 'createMaterialInstance',
      guid: newGuid,
      name,
      parentGuid,
      overrides,
      ...(livePayload.physMaterial ? { physMaterial: livePayload.physMaterial } : {}),
      packPath,
    }, 'human');
    if (!createResult.ok) return;

    gateway.dispatch({
      kind: 'openAssetEditor',
      asset: {
        guid: newGuid,
        kind: 'material-instance',
        name,
        packPath,
        payload: {
          kind: 'material-instance',
          parent: parentGuid,
          overrides,
          lightmass: livePayload.lightmass,
          ...(livePayload.physMaterial ? { physMaterial: livePayload.physMaterial } : {}),
          propertyOverrides: {},
        },
      },
    }, 'human');
  }, [asset, livePayload, packPath, guid, t]);

  const toggleGroup = (id: GroupId) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const groupVisible = (id: GroupId, labels: string[]): boolean => {
    if (!searching) return true;
    if (id.includes(q as never)) return true;
    return labels.some((label) => label.toLowerCase().includes(q));
  };
  const fieldVisible = (label: string): boolean => !searching || label.toLowerCase().includes(q);

  if (!asset || asset.kind !== 'material-instance' || !livePayload) {
    return <div className="field muted" data-testid="mi-editor-empty">No Material Instance selected.</div>;
  }

  const overrideOf = (key: string): MaterialInstanceOverride =>
    livePayload.overrides[key] ?? { enabled: false };

  const baseColor = (resolved.baseColor as number[] | undefined) ?? [1, 1, 1, 1];
  const metallic = localMetallic ?? (typeof resolved.metallic === 'number' ? resolved.metallic : 0);
  const roughness = localRoughness ?? (typeof resolved.roughness === 'number' ? resolved.roughness : 0.5);
  const lightmass = livePayload.lightmass;

  const surfaceLabels = ['Base Color', 'Metallic', 'Roughness'];
  const generalLabels = ['Parent', 'Phys Material'];
  const lightmassLabels = ['Cast Shadows as Masked', 'Emissive Boost', 'Diffuse Boost', 'Export Resolution Scale'];
  const propLabels = [...SURFACE_PARAM_KEYS];

  return (
    <div className="fx-inspector" data-testid="mi-editor">
      <div className="dp-search">
        <span className="mag"><ForgeaxIcon name="search" size={13} /></span>
        <input
          data-testid="mi-search"
          value={query}
          placeholder={t('editor.materialInstance.searchPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {groupVisible('surface', surfaceLabels) && (
        <div className={`cat${collapsed.has('surface') && !searching ? ' collapsed' : ''}`}>
          <div className="cat-head" onClick={() => toggleGroup('surface')}>
            <span className="car"><ForgeaxIcon name={collapsed.has('surface') && !searching ? 'chevronRight' : 'chevronDown'} size={12} /></span>
            <span className="ct">{t('editor.materialInstance.group.surface')}</span>
          </div>
          <div className="cat-fields">
            {fieldVisible('Base Color') && (
              <OverrideFieldRow
                label={t('editor.materialInstance.baseColor')}
                enabled={overrideOf('baseColor').enabled}
                testId="mi-baseColor"
                onEnabledChange={(enabled) => {
                  patchOverride(
                    'baseColor',
                    enabled,
                    enabled ? (overrideOf('baseColor').value ?? inherited.baseColor ?? baseColor) : undefined,
                  );
                }}
              >
                <input
                  type="color"
                  className="swatch"
                  disabled={!overrideOf('baseColor').enabled}
                  value={materialColorToHex(baseColor)}
                  onChange={(e) => {
                    const next = hexToMaterialColor(e.target.value, Array.isArray(baseColor) ? Number(baseColor[3] ?? 1) : 1);
                    patchOverride('baseColor', true, next);
                  }}
                />
              </OverrideFieldRow>
            )}
            {fieldVisible('Metallic') && (
              <OverrideFieldRow
                label={t('editor.materialInstance.metallic')}
                enabled={overrideOf('metallic').enabled}
                testId="mi-metallic"
                onEnabledChange={(enabled) => {
                  patchOverride(
                    'metallic',
                    enabled,
                    enabled ? (overrideOf('metallic').value ?? inherited.metallic ?? 0) : undefined,
                  );
                }}
              >
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  disabled={!overrideOf('metallic').enabled}
                  value={metallic}
                  onChange={(e) => setLocalMetallic(Number(e.target.value))}
                  onMouseUp={() => {
                    if (localMetallic !== null) {
                      patchOverride('metallic', true, localMetallic);
                      setLocalMetallic(null);
                    }
                  }}
                />
                <span className="hexval">{metallic.toFixed(3)}</span>
              </OverrideFieldRow>
            )}
            {fieldVisible('Roughness') && (
              <OverrideFieldRow
                label={t('editor.materialInstance.roughness')}
                enabled={overrideOf('roughness').enabled}
                testId="mi-roughness"
                onEnabledChange={(enabled) => {
                  patchOverride(
                    'roughness',
                    enabled,
                    enabled ? (overrideOf('roughness').value ?? inherited.roughness ?? 0.5) : undefined,
                  );
                }}
              >
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  disabled={!overrideOf('roughness').enabled}
                  value={roughness}
                  onChange={(e) => setLocalRoughness(Number(e.target.value))}
                  onMouseUp={() => {
                    if (localRoughness !== null) {
                      patchOverride('roughness', true, localRoughness);
                      setLocalRoughness(null);
                    }
                  }}
                />
                <span className="hexval">{roughness.toFixed(3)}</span>
              </OverrideFieldRow>
            )}
            <div className="f-row mi-save-related" data-testid="mi-save-related">
              <button type="button" data-testid="mi-save-sibling" onClick={() => void saveAsRelated('sibling')}>
                {t('editor.materialInstance.saveSibling')}
              </button>
              <button type="button" data-testid="mi-save-child" onClick={() => void saveAsRelated('child')}>
                {t('editor.materialInstance.saveChild')}
              </button>
            </div>
          </div>
        </div>
      )}

      {groupVisible('general', generalLabels) && (
        <div className={`cat${collapsed.has('general') && !searching ? ' collapsed' : ''}`}>
          <div className="cat-head" onClick={() => toggleGroup('general')}>
            <span className="car"><ForgeaxIcon name={collapsed.has('general') && !searching ? 'chevronRight' : 'chevronDown'} size={12} /></span>
            <span className="ct">{t('editor.materialInstance.group.general')}</span>
          </div>
          <div className="cat-fields">
            {fieldVisible('Parent') && (
              <div className="f-row" data-testid="mi-parent">
                <span className="f-name">{t('editor.materialInstance.parent')}</span>
                <span className="f-val asset-f">
                  <input className="an" readOnly value={livePayload.parent} title={livePayload.parent} />
                  <button type="button" onClick={() => setPicker('parent')} title="Browse parent">
                    <ForgeaxIcon name="folder" size={12} />
                  </button>
                </span>
              </div>
            )}
            {fieldVisible('Phys Material') && (
              <div className="f-row" data-testid="mi-physMaterial">
                <span className="f-name">{t('editor.materialInstance.physMaterial')}</span>
                <span className="f-val">{livePayload.physMaterial ?? 'DefaultPhysicalMaterial'}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {groupVisible('lightmass', lightmassLabels) && (
        <div className={`cat${collapsed.has('lightmass') && !searching ? ' collapsed' : ''}`}>
          <div className="cat-head" onClick={() => toggleGroup('lightmass')}>
            <span className="car"><ForgeaxIcon name={collapsed.has('lightmass') && !searching ? 'chevronRight' : 'chevronDown'} size={12} /></span>
            <span className="ct">{t('editor.materialInstance.group.lightmass')}</span>
          </div>
          <div className="cat-fields">
            {fieldVisible('Cast Shadows as Masked') && (
              <div className="f-row" data-testid="mi-castShadowsAsMasked">
                <span className="f-name">{t('editor.materialInstance.castShadowsAsMasked')}</span>
                <span className="f-val">
                  <input
                    type="checkbox"
                    checked={lightmass.castShadowsAsMasked}
                    onChange={(e) => patchLightmass({ castShadowsAsMasked: e.target.checked })}
                  />
                </span>
              </div>
            )}
            {([
              ['emissiveBoost', 'Emissive Boost'],
              ['diffuseBoost', 'Diffuse Boost'],
              ['exportResolutionScale', 'Export Resolution Scale'],
            ] as const).map(([key, searchLabel]) => (
              fieldVisible(searchLabel) ? (
                <div className="f-row" data-testid={`mi-${key}`} key={key}>
                  <span className="f-name">{t(`editor.materialInstance.${key}`)}</span>
                  <span className="f-val">
                    <input
                      type="number"
                      step={0.1}
                      min={0}
                      value={lightmass[key]}
                      onChange={(e) => patchLightmass({ [key]: Number(e.target.value) })}
                    />
                  </span>
                </div>
              ) : null
            ))}
          </div>
        </div>
      )}

      {groupVisible('propertyOverrides', propLabels) && (
        <div className={`cat${collapsed.has('propertyOverrides') && !searching ? ' collapsed' : ''}`}>
          <div className="cat-head" onClick={() => toggleGroup('propertyOverrides')}>
            <span className="car"><ForgeaxIcon name={collapsed.has('propertyOverrides') && !searching ? 'chevronRight' : 'chevronDown'} size={12} /></span>
            <span className="ct">{t('editor.materialInstance.group.propertyOverrides')}</span>
          </div>
          <div className="cat-fields">
            <div className="field muted" data-testid="mi-property-overrides-placeholder">
              {t('editor.materialInstance.propertyOverridesHint')}
            </div>
            {SURFACE_PARAM_KEYS.map((key) => (
              fieldVisible(key) && (
                <OverrideFieldRow
                  key={key}
                  label={key}
                  enabled={(livePayload.propertyOverrides?.[key] ?? livePayload.overrides[key])?.enabled ?? false}
                  testId={`mi-prop-${key}`}
                  onEnabledChange={(enabled) => {
                    patchOverride(
                      key,
                      enabled,
                      enabled ? (livePayload.overrides[key]?.value ?? inherited[key] ?? resolved[key]) : undefined,
                      'propertyOverrides',
                    );
                  }}
                >
                  <span className="hexval">{String(resolved[key] ?? '—')}</span>
                </OverrideFieldRow>
              )
            ))}
          </div>
        </div>
      )}

      {picker === 'parent' && (
        <AssetPicker
          assetType="MaterialAsset"
          currentGuid={livePayload.parent}
          onPick={(nextGuid) => {
            patchParent(nextGuid);
            setPicker(null);
          }}
          onClear={() => setPicker(null)}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

export default MaterialInstanceEditor;
