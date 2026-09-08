import type { ReactElement } from 'react';
import { PropertyRow } from './PropertyRow';
import { InspectorForm, InspectorSection } from './InspectorSection';
import type { PreviewProps } from './index';

export default function AssetPreviewShader({ payload }: PreviewProps): ReactElement {
  const name = payload.name as string | undefined;
  const paramSchema = Array.isArray(payload.paramSchema) ? payload.paramSchema.length : 0;
  const source = typeof payload.source === 'string' ? payload.source : '';
  const preview = source.length > 200 ? source.slice(0, 200) + '…' : source;

  return (
    <InspectorForm testId="preview-shader">
      <InspectorSection id="shader" title="Shader" dim="type">
        {name && <PropertyRow label="Name" value={name} />}
        <PropertyRow label="Param Fields" value={paramSchema} />
      </InspectorSection>
      {preview && (
        <InspectorSection id="shader-source" title="Source Preview" dim="cap">
          <pre className="asset-source">{preview}</pre>
        </InspectorSection>
      )}
    </InspectorForm>
  );
}
