import { useCallback, useState } from 'react';
import { useAssetSelection, gateway } from '@forgeax/editor-core';
import { PropertyRow } from './PropertyRow';
import type { PreviewProps } from './index';

interface PassDesc {
  name?: string;
  shader?: string;
}

/** Engine SSOT: user-region texture field names (derive-paramschema.ts:287-291). */
const TEXTURE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
]);

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

function TextureThumb({ label, guid, onClear }: { label: string; guid: string; onClear?: () => void }) {
  const shortGuid = guid.length > 18 ? `${guid.slice(0, 18)}…` : guid;
  return (
    <div className="field" data-testid={`mat-${label}`}>
      <label title={`Texture GUID: ${guid}`}>
        <span style={{ marginRight: 6 }}>🖼</span>
        {label}
      </label>
      <span className="muted" style={{ fontSize: '0.82em', fontFamily: 'monospace' }}>
        {shortGuid}
      </span>
      {onClear && (
        <button
          className="mat-clear-btn"
          title="Clear texture"
          onClick={onClear}
          style={{ marginLeft: 6, fontSize: '0.75em', cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 4px', background: 'transparent', color: 'var(--text-muted)' }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

export default function AssetPreviewMaterial({ payload }: PreviewProps) {
  const asset = useAssetSelection();
  const passes = Array.isArray(payload.passes) ? (payload.passes as PassDesc[]) : [];
  const parent = payload.parent as string | undefined;
  const paramValues = (payload.paramValues ?? {}) as Record<string, unknown>;

  const baseColor = Array.isArray(paramValues.baseColor) ? paramValues.baseColor as number[] : [1, 1, 1, 1];
  const metallic = typeof paramValues.metallic === 'number' ? paramValues.metallic : 0;
  const roughness = typeof paramValues.roughness === 'number' ? paramValues.roughness : 0.5;

  const [localMetallic, setLocalMetallic] = useState(metallic);
  const [localRoughness, setLocalRoughness] = useState(roughness);

  const canEdit = !!asset?.packPath && !!asset?.guid;

  const dispatchParam = useCallback((paramPatch: Record<string, unknown>) => {
    if (!asset) return;
    gateway.dispatch({
      kind: 'updateMaterialParams',
      packPath: asset.packPath,
      guid: asset.guid,
      paramPatch,
    }, 'human');
  }, [asset]);

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

  const handleClearTexture = useCallback((key: string) => {
    if (!asset) return;
    gateway.dispatch({
      kind: 'updateMaterialParams',
      packPath: asset.packPath,
      guid: asset.guid,
      paramPatch: { [key]: undefined },
      textureGuids: { [key]: null },
    }, 'human');
  }, [asset]);

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
        <PropertyRow key={i} label={`  Pass ${i}`} value={`${p.name ?? '?'} → ${p.shader ?? '?'}`} />
      ))}

      {parent && <PropertyRow label="Parent" value={parent} />}

      {/* Texture fields */}
      {Object.entries(paramValues).map(([k, v]) => {
        if (!TEXTURE_FIELD_NAMES.has(k)) return null;
        if (typeof v === 'string' && v.length > 0) {
          return <TextureThumb key={k} label={k} guid={v} onClear={canEdit ? () => handleClearTexture(k) : undefined} />;
        }
        if (typeof v === 'number') {
          return (
            <div className="field" key={k} data-testid={`mat-${k}`}>
              <label>{k}</label>
              <span className="muted" style={{ fontSize: '0.82em' }}>ref[{v}]</span>
              {canEdit && (
                <button
                  className="mat-clear-btn"
                  title="Clear texture"
                  onClick={() => handleClearTexture(k)}
                  style={{ marginLeft: 6, fontSize: '0.75em', cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 4px', background: 'transparent', color: 'var(--text-muted)' }}
                >
                  ✕
                </button>
              )}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
