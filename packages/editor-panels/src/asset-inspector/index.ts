import { lazy, type ComponentType } from 'react';

export interface PreviewProps {
  payload: Record<string, unknown>;
}

const lz = (load: () => Promise<{ default: ComponentType<PreviewProps> }>) =>
  lazy(load);

export const PREVIEW_COMPONENTS: Record<string, ComponentType<PreviewProps>> = {
  mesh: lz(() => import('./AssetPreviewMesh')),
  texture: lz(() => import('./AssetPreviewTexture')),
  image: lz(() => import('./AssetPreviewTexture')),
  'cube-texture': lz(() => import('./AssetPreviewCubeTexture')),
  sampler: lz(() => import('./AssetPreviewSampler')),
  material: lz(() => import('./AssetPreviewMaterial')),
  scene: lz(() => import('./AssetPreviewScene')),
  shader: lz(() => import('./AssetPreviewShader')),
  skeleton: lz(() => import('./AssetPreviewSkeleton')),
  skin: lz(() => import('./AssetPreviewSkin')),
  'animation-clip': lz(() => import('./AssetPreviewAnimationClip')),
  audio: lz(() => import('./AssetPreviewAudio')),
  font: lz(() => import('./AssetPreviewFont')),
  'render-pipeline': lz(() => import('./AssetPreviewRenderPipeline')),
  tileset: lz(() => import('./AssetPreviewTileset')),
};
