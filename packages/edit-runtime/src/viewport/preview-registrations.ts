// preview-registrations — the ONE canonical host wiring for the asset preview
// slots (material / material-instance / mesh / vfx).
//
// panels must not import edit-runtime (DAG), so the preview panels render a
// "not registered by the host" placeholder until the host injects the real
// viewport components through the slot registers. Every host that mounts
// EDITOR_PANEL_COMPONENTS must call registerEditorPreviewViewports() once at
// module scope — standalone (apps/standalone/main.tsx) and Studio
// (packages/studio/src/panels/editorRenderers.tsx) included. Exposed as the
// @forgeax/editor/previews facade subpath because boundary rule 6 forbids
// hosts from importing editor-edit-runtime internals directly.
import {
  registerMaterialInstancePreview,
  registerMeshPreview,
  registerVfxPreview,
} from '@forgeax/editor-panels';
import { MaterialPreviewViewport } from './MaterialPreviewViewport';
import { MeshPreviewViewport } from './MeshPreviewViewport';
import { VfxPreviewViewport } from './VfxPreviewViewport';

export function registerEditorPreviewViewports(): void {
  registerMaterialInstancePreview(MaterialPreviewViewport);
  registerMeshPreview(MeshPreviewViewport);
  registerVfxPreview(VfxPreviewViewport);
}
