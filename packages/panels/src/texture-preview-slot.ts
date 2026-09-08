// texture-preview-slot — host/edit-runtime injects the real Texture GPU preview.
//
// panels owns the panel shell only. The runtime component is injected by the
// host so the package DAG remains core ← panels ← edit-runtime.

import type { ComponentType } from 'react';

let PreviewViewport: ComponentType | null = null;

export function registerTexturePreview(component: ComponentType | null): void {
  PreviewViewport = component;
}

export function getTexturePreview(): ComponentType | null {
  return PreviewViewport;
}
