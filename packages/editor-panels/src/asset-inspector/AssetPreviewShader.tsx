import { PropertyRow } from './PropertyRow';
import type { PreviewProps } from './index';

export default function AssetPreviewShader({ payload }: PreviewProps) {
  const name = payload.name as string | undefined;
  const paramSchema = Array.isArray(payload.paramSchema) ? payload.paramSchema.length : 0;
  const source = typeof payload.source === 'string' ? payload.source : '';
  const preview = source.length > 200 ? source.slice(0, 200) + '…' : source;

  return (
    <div data-testid="preview-shader">
      <div className="compname">Shader</div>
      {name && <PropertyRow label="Name" value={name} />}
      <PropertyRow label="Param Fields" value={paramSchema} />
      {preview && (
        <div className="field">
          <label>Source Preview</label>
          <pre style={{ fontSize: '0.8em', whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto', margin: 0 }}>
            {preview}
          </pre>
        </div>
      )}
    </div>
  );
}
