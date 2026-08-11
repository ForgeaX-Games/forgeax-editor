// mesh-preview-slot — host/edit-runtime injects the real Mesh 3D preview.
//
// panels owns the panel shell only. The runtime component is injected by the
// host so the package DAG remains core ← panels ← edit-runtime.

import type { ComponentType } from 'react';

let PreviewViewport: ComponentType | null = null;

export function registerMeshPreview(component: ComponentType | null): void {
  PreviewViewport = component;
}

export function getMeshPreview(): ComponentType | null {
  return PreviewViewport;
}

