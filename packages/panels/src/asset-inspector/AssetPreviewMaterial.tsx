import { PropertyRow } from './PropertyRow';
import type { PreviewProps } from './index';

interface PassDesc {
  name?: string;
  shader?: string;
}

/** Engine SSOT: user-region texture field names (derive-paramschema.ts:287-291).
 *  These are the material param keys that store texture GUIDs. */
const TEXTURE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
]);

function TextureThumb({ label, guid }: { label: string; guid: string }) {
  const shortGuid = guid.length > 18 ? `${guid.slice(0, 18)}…` : guid;
  return (
    <div className="field" data-testid={`preview-material-tex-${label}`}>
      <label title={`Texture GUID: ${guid}`}>
        <span style={{ marginRight: 6 }}>🖼</span>
        {label}
      </label>
      <span className="muted" style={{ fontSize: '0.82em', fontFamily: 'monospace' }}>
        {shortGuid}
      </span>
    </div>
  );
}

export default function AssetPreviewMaterial({ payload }: PreviewProps) {
  const passes = Array.isArray(payload.passes) ? (payload.passes as PassDesc[]) : [];
  const parent = payload.parent as string | undefined;
  const paramValues = payload.paramValues as Record<string, unknown> | undefined;
  const paramKeys = paramValues ? Object.keys(paramValues) : [];

  return (
    <div data-testid="preview-material">
      <div className="compname">Material</div>
      <PropertyRow label="Passes" value={passes.length} />
      {passes.map((p, i) => (
        <PropertyRow key={i} label={`  Pass ${i}`} value={`${p.name ?? '?'} → ${p.shader ?? '?'}`} />
      ))}
      {parent && <PropertyRow label="Parent" value={parent} />}
      <PropertyRow label="Params" value={paramKeys.length > 0 ? paramKeys.join(', ') : '(none)'} />
      {paramValues && paramKeys.map(k => {
        const v = paramValues[k];
        // Texture GUID fields → render as thumbnail row
        if (TEXTURE_FIELD_NAMES.has(k) && typeof v === 'string' && v.length > 0) {
          return <TextureThumb key={k} label={k} guid={v} />;
        }
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
          return <PropertyRow key={k} label={`  ${k}`} value={v} />;
        }
        return null;
      })}
    </div>
  );
}
