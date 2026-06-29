import { PropertyRow } from './PropertyRow';
import type { PreviewProps } from './index';

interface PassDesc {
  name?: string;
  shader?: string;
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
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
          return <PropertyRow key={k} label={`  ${k}`} value={v} />;
        }
        return null;
      })}
    </div>
  );
}
