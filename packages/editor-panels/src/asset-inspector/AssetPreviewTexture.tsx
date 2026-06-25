import { PropertyRow } from './PropertyRow';
import type { PreviewProps } from './index';

function resolvePreviewUrl(payload: Record<string, unknown>): string | undefined {
  const source = payload.source as string | undefined;
  const packPath = payload._packPath as string | undefined;
  if (!source || !packPath) return undefined;
  const dir = packPath.replace(/[^/]+$/, '');
  return `/api/files/raw?path=${encodeURIComponent(`${dir}${source}`)}`;
}

export default function AssetPreviewTexture({ payload }: PreviewProps) {
  const previewUrl = resolvePreviewUrl(payload);
  return (
    <div data-testid="preview-texture">
      <div className="compname">Texture</div>
      {previewUrl && (
        <div style={{ marginBottom: 8, textAlign: 'center' }}>
          <img
            src={previewUrl}
            alt="Texture preview"
            style={{ maxWidth: '100%', maxHeight: 200, objectFit: 'contain', borderRadius: 4, border: '1px solid #333' }}
          />
        </div>
      )}
      <PropertyRow label="Width" value={payload.width} />
      <PropertyRow label="Height" value={payload.height} />
      <PropertyRow label="Format" value={payload.format} />
      <PropertyRow label="Color Space" value={payload.colorSpace} />
      <PropertyRow label="Mipmap" value={payload.mipmap != null ? String(payload.mipmap) : '—'} />
      <PropertyRow label="Mip Levels" value={payload.mipLevelCount} />
      <PropertyRow label="Sample Count" value={payload.sampleCount} />
    </div>
  );
}
