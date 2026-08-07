// mi-preview-slot — host/edit-runtime injects the real 3D preview (M5).
//
// panels must not import edit-runtime (DAG). The host registers the viewport
// component; until then MaterialInstancePreviewPanel shows a placeholder.

import type { ComponentType } from 'react';

let PreviewViewport: ComponentType | null = null;

export function registerMaterialInstancePreview(component: ComponentType | null): void {
  PreviewViewport = component;
}

export function getMaterialInstancePreview(): ComponentType | null {
  return PreviewViewport;
}
