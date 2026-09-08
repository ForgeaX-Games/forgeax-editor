import type { ReactElement } from 'react';
import { PropertyRow } from './PropertyRow';
import { InspectorForm, InspectorSection } from './InspectorSection';
import type { PreviewProps } from './index';
import {
  texturePreviewDescriptor,
  type TexturePreviewRequest,
} from '@forgeax/engine-preview';

type TexturePreviewPrimitive = TexturePreviewRequest & {
  readonly operationId: typeof texturePreviewDescriptor.id;
  readonly source: 'engine';
};

export type TexturePreviewProjection = TexturePreviewPrimitive | {
  readonly ok: false;
  readonly code: 'texture-preview-binding-unavailable';
};

function textureChannels(format: string): number {
  if (format.includes('rgba') || format.includes('bgra')) return 4;
  if (format.includes('rgb')) return 3;
  if (format.includes('rg')) return 2;
  return 1;
}

export function projectTexturePreview(guid: string, payload: Record<string, unknown>): TexturePreviewProjection {
  const width = payload.width;
  const height = payload.height;
  const format = payload.format;
  const colorSpace = payload.colorSpace;
  const mipLevels = payload.mipLevelCount ?? (payload.mipmap === true ? 1 : undefined);
  if (
    payload.kind !== 'texture'
    || typeof width !== 'number' || !Number.isSafeInteger(width) || width < 1
    || typeof height !== 'number' || !Number.isSafeInteger(height) || height < 1
    || typeof format !== 'string' || format.length === 0
    || (colorSpace !== 'linear' && colorSpace !== 'srgb' && colorSpace !== 'hdr')
    || typeof mipLevels !== 'number' || !Number.isSafeInteger(mipLevels) || mipLevels < 1
  ) return { ok: false, code: 'texture-preview-binding-unavailable' };
  try {
    const request: TexturePreviewRequest = {
      subject: { kind: 'TextureAsset', guid },
      snapshot: { revision: 0, digest: `editor-projection:${guid}:0` },
      binding: {
        guid,
        width,
        height,
        format,
        colorSpace,
        alpha: Boolean(payload.alpha ?? (format.includes('rgba') || format.includes('bgra'))),
        mipLevels,
        channels: textureChannels(format),
      },
    };
    return Object.freeze({ ...request, operationId: texturePreviewDescriptor.id, source: 'engine' });
  } catch {
    return { ok: false, code: 'texture-preview-binding-unavailable' };
  }
}

function resolvePreviewUrl(payload: Record<string, unknown>): string | undefined {
  const source = payload.source as string | undefined;
  const packPath = payload._packPath as string | undefined;
  if (!source || !packPath) return undefined;
  const dir = packPath.replace(/[^/]+$/, '');
  return `/api/files/raw?path=${encodeURIComponent(`${dir}${source}`)}`;
}

export default function AssetPreviewTexture({ payload }: PreviewProps): ReactElement {
  const previewUrl = resolvePreviewUrl(payload);
  const primitive = projectTexturePreview(String(payload.guid ?? payload._guid ?? 'unknown'), payload);
  return (
    <InspectorForm testId="preview-texture">
      {'operationId' in primitive && (
        <div data-preview-operation-id={primitive.operationId} data-preview-source={primitive.source} data-preview-subject={primitive.subject.guid} />
      )}
      <InspectorSection id="texture-image" title="Image" dim="type">
        {previewUrl && (
          <div className="asset-media">
            <img src={previewUrl} alt="Texture preview" />
          </div>
        )}
        <PropertyRow label="Width" value={payload.width} />
        <PropertyRow label="Height" value={payload.height} />
        <PropertyRow label="Format" value={payload.format} />
        <PropertyRow label="Color Space" value={payload.colorSpace} />
      </InspectorSection>
      <InspectorSection id="texture-mipmaps" title="Mipmaps" dim="all">
        <PropertyRow label="Mipmap" value={payload.mipmap != null ? String(payload.mipmap) : '—'} />
        <PropertyRow label="Mip Levels" value={payload.mipLevelCount} />
        <PropertyRow label="Sample Count" value={payload.sampleCount} />
      </InspectorSection>
    </InspectorForm>
  );
}
