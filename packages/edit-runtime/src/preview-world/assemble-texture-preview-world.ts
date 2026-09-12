// @forgeax/editor-edit-runtime — isolated Texture preview-world assembly (STD-01).
//
// Mirrors the engine devkit texture.preview canonical rig: orthographic camera,
// aspect-preserving quad, unlit material sampling the bound TextureAsset. The
// assembly is a disposable presentation carrier; Engine preview primitives
// remain the binding authority.

import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import type { EntityHandle } from '@forgeax/engine-ecs';
import {
  Camera,
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  Materials,
  MeshFilter,
  MeshRenderer,
  TONEMAP_NONE,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { Handle, MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import type { TexturePreviewPrimitive } from '@forgeax/engine-preview';
import type { EngineFacade } from '@forgeax/editor-core';
import type { TexturePreviewViewState } from './texture-preview-view-state';

export interface TexturePreviewDimensions {
  readonly width: number;
  readonly height: number;
}

export interface TexturePreviewOrthoView {
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
}

export const DEFAULT_TEXTURE_ORTHO_VIEW: TexturePreviewOrthoView = Object.freeze({
  zoom: 1,
  panX: 0,
  panY: 0,
});

function textureAspectScale(width: number, height: number): readonly [number, number, number] {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const aspect = safeWidth / safeHeight;
  return aspect >= 1 ? [aspect, 1, 1] : [1, 1 / aspect, 1];
}

function resolveDisplayColorSpace(
  asset: TextureAsset,
  display: TexturePreviewViewState['colorSpaceDisplay'],
): 'srgb' | 'linear' {
  if (display === 'srgb') return 'srgb';
  if (display === 'linear') return 'linear';
  return asset.colorSpace;
}

export interface TexturePreviewAssembly {
  readonly camera: EntityHandle;
  readonly subject: EntityHandle;
  readonly materialHandle: unknown;
  readonly dimensions: TexturePreviewDimensions;
  readonly enginePrimitive?: TexturePreviewPrimitive;
  replaceTexture(texture: TextureAsset, textureHandle: Handle<'TextureAsset', 'shared'>, view: TexturePreviewViewState): void;
  applyViewState(view: TexturePreviewViewState): void;
  applyOrthoView(ortho: TexturePreviewOrthoView): void;
  resetOrthoView(): void;
  setEnginePrimitive(primitive: TexturePreviewPrimitive): void;
}

export function assembleTexturePreviewWorld(facade: EngineFacade): TexturePreviewAssembly {
  const camera = facade.spawn(
    { component: Transform, data: { pos: [0, 0, 5] } },
    {
      component: Camera,
      data: {
        fov: 0,
        aspect: 1,
        near: 0.01,
        far: 100,
        projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
        left: -0.6,
        right: 0.6,
        bottom: -0.6,
        top: 0.6,
        tonemap: TONEMAP_NONE,
        antialias: 0,
        bloom: 0,
        clearColor: [0, 0, 0, 1],
      },
    },
  ).unwrap();

  const materialPayload = Materials.unlit([1, 1, 1, 1]) as MaterialAsset;
  const materialHandle = facade.allocSharedRef('MaterialAsset', materialPayload);

  const subject = facade.spawn(
    { component: Transform, data: { pos: [0, 0, 0], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();

  let dimensions: TexturePreviewDimensions = { width: 1, height: 1 };
  let orthoView: TexturePreviewOrthoView = { ...DEFAULT_TEXTURE_ORTHO_VIEW };
  let viewState: TexturePreviewViewState | undefined;
  let enginePrimitive: TexturePreviewPrimitive | undefined;
  let boundTextureHandle: Handle<'TextureAsset', 'shared'> | undefined;
  let activeMaterialHandle = materialHandle;
  let activeTexture: TextureAsset | undefined;

  const syncCamera = (): void => {
    const scale = textureAspectScale(dimensions.width, dimensions.height);
    const tiling = viewState?.tiling ?? 1;
    const halfX = (scale[0] * 0.6) / orthoView.zoom;
    const halfY = (scale[1] * 0.6) / orthoView.zoom;
    const spanX = halfX * tiling;
    const spanY = halfY * tiling;
    facade.set(camera, Camera, {
      left: -spanX + orthoView.panX,
      right: spanX + orthoView.panX,
      bottom: -spanY + orthoView.panY,
      top: spanY + orthoView.panY,
      clearColor: viewState?.checkerboardVisible === false ? [0.08, 0.1, 0.13, 1] : [0, 0, 0, 0],
    }).unwrap();
  };

  const syncSubject = (): void => {
    const scale = textureAspectScale(dimensions.width, dimensions.height);
    const tiling = viewState?.tiling ?? 1;
    facade.set(subject, Transform, {
      pos: [0, 0, 0],
      scale: [scale[0] / tiling, scale[1] / tiling, 1],
    }).unwrap();
    syncCamera();
  };

  const rebuildMaterial = (texture: TextureAsset, view: TexturePreviewViewState): void => {
    const colorSpace = resolveDisplayColorSpace(texture, view.colorSpaceDisplay);
    const payload = Materials.unlit([1, 1, 1, 1], {
      colorSpace,
      ...(boundTextureHandle === undefined ? {} : { baseColorTexture: boundTextureHandle }),
    }) as MaterialAsset;
    activeMaterialHandle = facade.allocSharedRef('MaterialAsset', payload);
    facade.set(subject, MeshRenderer, { materials: [activeMaterialHandle] }).unwrap();
  };

  return {
    camera,
    subject,
    materialHandle,
    get dimensions() { return dimensions; },
    get enginePrimitive() { return enginePrimitive; },
    replaceTexture(texture, textureHandle, view) {
      boundTextureHandle = textureHandle;
      activeTexture = texture;
      dimensions = { width: texture.width, height: texture.height };
      viewState = view;
      rebuildMaterial(texture, view);
      syncSubject();
    },
    applyViewState(view) {
      viewState = view;
      if (activeTexture !== undefined && boundTextureHandle !== undefined) {
        rebuildMaterial(activeTexture, view);
      }
      syncSubject();
    },
    applyOrthoView(ortho) {
      orthoView = ortho;
      syncCamera();
    },
    resetOrthoView() {
      orthoView = { ...DEFAULT_TEXTURE_ORTHO_VIEW };
      syncCamera();
    },
    setEnginePrimitive(primitive) {
      enginePrimitive = primitive;
    },
  };
}
