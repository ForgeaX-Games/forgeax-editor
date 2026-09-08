// @forgeax/editor-panels — panel manifest re-export + component injection
//
// The SSOT for panel IDs lives in @forgeax/editor-core (manifest.ts).
// This file imports from there, re-exports the manifest, and injects the
// concrete panel component list that core (which has no UI dep on panels)
// cannot hold.

// ── Manifest SSOT (from @forgeax/editor-core) ──
import {
  EDITOR_PANELS,
  EDITOR_PANEL_TITLES,
  type EditorPanelId,
} from '@forgeax/editor-core';
export { EDITOR_PANELS, EDITOR_PANEL_TITLES };
export type { EditorPanelId };

// ── Panel component lookup — injected by panels, not carried by core ──
import React from 'react';
import type { AppExtension } from '@forgeax/interface/core/app-shell/types';
import { createPanelsEditorExtension } from '@forgeax/interface/core/extensions/panels-editor';
import { AssetsPanel } from './Assets';
import { CapabilitiesPanel } from './Capabilities';
import { HierarchyPanel } from './Hierarchy';
import { HistoryPanel } from './History';
import { InspectorPanel } from './Inspector';
import { LauncherPanel } from './Launcher';
import {
  AssetPropertiesPanel,
  MaterialInstancePreviewPanel,
  MaterialInstancePropertiesPanel,
  MaterialPreviewPanel,
  MeshPreviewPanel,
  TexturePreviewPanel,
  MeshSlotsPanel,
  InputMapPropertiesPanel,
} from './AssetEditors';
import { UvEditorPanel } from './UvEditorPanel';
import { SettingsPanel } from './Settings';
import { OperationCenter } from './operations/OperationCenter';
import {
  VfxDetailsPanel,
  VfxDiagnosticsPanel,
  VfxPreviewPanel,
  VfxSystemPanel,
  VfxTimelinePanel,
} from './VfxEditor';
export {
  registerMaterialInstancePreview,
  getMaterialInstancePreview,
} from './mi-preview-slot';
export {
  registerMeshPreview,
  getMeshPreview,
} from './mesh-preview-slot';
export {
  registerTexturePreview,
  getTexturePreview,
} from './texture-preview-slot';
export { registerVfxPreview, getVfxPreview } from './vfx-preview-slot';

// D5 (plan-strategy §2): renamed PANEL_COMPONENTS -> EDITOR_PANEL_COMPONENTS to
// disambiguate from interface's own same-named PANEL_COMPONENTS
// (panelRegistry.tsx). The host injects this map into DockShell's
// renderEditorPanel slot; the EDITOR_ prefix lets an agent grep the correct
// symbol in one hit (research §8 naming; AC-04/AC-05 single-realm injection).
//
// To add a panel: (1) register its id in the EDITOR_PANELS SSOT
// (@forgeax/editor-core manifest.ts); (2) add the component here keyed by that
// id. The host reads this map via renderEditorPanel(id); an unmapped id falls
// back to the "panel not assembled" placeholder (no crash).
export const EDITOR_PANEL_COMPONENTS: Record<string, React.ComponentType<any>> = {
  hierarchy: HierarchyPanel,
  inspector: InspectorPanel,
  assets: AssetsPanel,
  history: HistoryPanel,
  capabilities: CapabilitiesPanel,
  launcher: LauncherPanel,
  settings: SettingsPanel,
  'asset-properties': AssetPropertiesPanel,
  'mesh-slots': MeshSlotsPanel,
  'mi-preview': MaterialInstancePreviewPanel,
  'mi-properties': MaterialInstancePropertiesPanel,
  'mat-preview': MaterialPreviewPanel,
  'texture-preview': TexturePreviewPanel,
  'mesh-preview': MeshPreviewPanel,
  'uv-editor': UvEditorPanel,
  'input-map-properties': InputMapPropertiesPanel,
  'vfx-system': VfxSystemPanel,
  'vfx-preview': VfxPreviewPanel,
  'vfx-timeline': VfxTimelinePanel,
  'vfx-details': VfxDetailsPanel,
  'vfx-diagnostics': VfxDiagnosticsPanel,
  'operation-center': OperationCenter,
};

function editorPanelTitle(id: EditorPanelId): string {
  return id === 'assets' ? 'Content Browser' : (EDITOR_PANEL_TITLES[id] ?? id);
}

/** Render one editor-owned panel without requiring each host to rebuild its body. */
export function renderEditorPanel(id: string): React.ReactNode {
  const Comp = EDITOR_PANEL_COMPONENTS[id];
  if (Comp) return React.createElement(Comp);
  return React.createElement(
    'div',
    { className: 'surface-placeholder', 'data-panel': id, 'data-panel-unmounted': '1' },
    React.createElement('div', { className: 'surface-placeholder-title' }, 'Panel not mounted'),
  );
}

export interface CreateEditorPanelsExtensionOptions {
  /** Host-specific authoritative viewport surface; panel metadata remains editor-owned. */
  SceneEditor: React.ComponentType;
}

/**
 * Editor panel contribution SSOT. Hosts provide only the viewport carrier;
 * panel identity, chrome, content policy, windowing, and rendering stay here.
 *
 * Note: asset-editor panels (asset-properties / mi-properties / mat-preview /
 * mi-preview / input-map-properties) do NOT hardcode `header.visible` here — the
 * operation header is DERIVED by PanelShell from whether the panel currently has
 * a `when`-passing action/control contributed (asset-editors-contributions,
 * material-preview-toolbar). A panel "owns" its header simply by having live
 * contributions, so there is no central whitelist to keep in sync. `hierarchy`
 * keeps an explicit flag because its header is part of its always-on chrome.
 */
export function createEditorPanelsExtension(
  options: CreateEditorPanelsExtensionOptions,
): AppExtension {
  const panels = Object.fromEntries(
    EDITOR_PANELS.map((id, index) => [id, {
      title: editorPanelTitle(id),
      order: 100 + index,
      ...(id === 'assets'
        ? {
            content: { padding: 'none' as const, scroll: 'none' as const, tone: 'tool' as const },
          }
        : id === 'hierarchy'
          ? {
              header: { visible: true, showTitle: false },
              content: { padding: 'none' as const, scroll: 'none' as const, tone: 'tool' as const },
            }
          : {}),
      windowing: {
        createTarget: () => ({
          surface: { kind: 'panel' as const, id: `ep:${id}` },
          title: editorPanelTitle(id),
          width: 960,
          height: 720,
          dockBehavior: 'close' as const,
        }),
      },
      render: () => renderEditorPanel(id),
    }]),
  );

  return createPanelsEditorExtension({
    editorPanelIds: [...EDITOR_PANELS],
    panels,
    surfaces: { SceneEditor: options.SceneEditor },
  });
}
