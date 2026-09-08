// asset-editors-contributions — panel-header actions for the asset editor
// pages (Material, Material Instance, Input Map).
//
// Mirrors HierarchyContributions: one AppExtension registers commands, declares
// panelActions that reference them, and projects the context keys the actions'
// when/enablement expressions read. The panel bodies render no toolbar of their
// own — PanelShell paints the header from host.panelActions.list(panelId).
//
// Bridging model (see plan): Material / Input Map header Save routes through
// `editor.save` (same path as File menu + Mod+S contextual keybinding) so
// material-first diversion cannot be bypassed by panel chrome. Actions whose body closes
// over a live React closure (Material Instance Save Sibling/Child, Input Map
// + Action / Import / Export) call a module-level handler ref the panel refreshes
// each render.
import type { AppExtension, AppHost } from '@forgeax/interface/core/app-shell/types';
import {
  getActiveEditorAsset,
  getInputMapStaging,
  isInputMapStagingDirty,
  isMaterialStagingDirty,
  subscribeActiveEditorAsset,
  subscribeInputMapStaging,
  subscribeMaterialStaging,
} from '@forgeax/editor-core';
import {
  collapseAllMaterialCategories,
  expandAllMaterialCategories,
} from './asset-inspector/material-category-state';
import { getMiCommandActions } from './asset-inspector/MaterialInstanceEditor';
import { getInputMapCommandActions } from './asset-inspector/InputMapEditor';

function done(): { status: 'completed' } {
  return { status: 'completed' };
}

// ── Context-key projection ──────────────────────────────────────────────────

function syncAssetEditorsContext(host: AppHost): void {
  const asset = getActiveEditorAsset();
  const kind = asset?.kind ?? null;
  const materialDirty = !!asset && kind === 'material' && isMaterialStagingDirty(asset.guid);
  const inputMapActive = !!asset && kind === 'input-map';
  const inputMapDirty = inputMapActive && isInputMapStagingDirty(asset.guid);
  const inputMapSaving = inputMapActive && getInputMapStaging(asset.guid)?.saveStatus === 'saving';

  host.contextKeys.set('panel.asset-properties.kind', kind);
  host.contextKeys.set('panel.asset-properties.materialDirty', materialDirty);
  host.contextKeys.set('panel.mi-properties.mounted', kind === 'material-instance');
  host.contextKeys.set('panel.input-map-properties.mounted', inputMapActive);
  host.contextKeys.set('panel.input-map-properties.canSave', Boolean(inputMapDirty && !inputMapSaving));
}

const CONTEXT_KEYS = [
  'panel.asset-properties.kind',
  'panel.asset-properties.materialDirty',
  'panel.mi-properties.mounted',
  'panel.input-map-properties.mounted',
  'panel.input-map-properties.canSave',
] as const;

// ── Extension ───────────────────────────────────────────────────────────────

export function createAssetEditorsPanelContributionsExtension(): AppExtension {
  return {
    id: 'editor.asset-editors-panel-contributions',
    version: '1.0.0',
    requires: ['commands', 'panelActions', 'contextKeys'],
    setup(ctx) {
      const host = ctx.host;
      syncAssetEditorsContext(host);

      const cleanups: Array<() => void> = [
        // Material parameter editor. Save + Expand/Collapse All are three flat
        // buttons laid out on the header's left (the search field is a control
        // registered by AssetPreviewMaterial to their right).
        host.commands.register({
          id: 'material.save',
          title: 'Material: Save',
          execute: () => {
            void host.commands.execute('editor.save');
            return done();
          },
        }),
        host.commands.register({ id: 'material.expandAll', title: 'Material: Expand All Categories', execute: () => { expandAllMaterialCategories(); return done(); } }),
        host.commands.register({ id: 'material.collapseAll', title: 'Material: Collapse All Categories', execute: () => { collapseAllMaterialCategories(); return done(); } }),

        // Material Instance related-save (handler ref refreshed by the panel).
        host.commands.register({ id: 'materialInstance.saveSibling', title: 'Material Instance: Save Sibling', when: () => getMiCommandActions() != null, execute: () => { getMiCommandActions()?.saveSibling(); return done(); } }),
        host.commands.register({ id: 'materialInstance.saveChild', title: 'Material Instance: Save Child', when: () => getMiCommandActions() != null, execute: () => { getMiCommandActions()?.saveChild(); return done(); } }),

        // Input Map toolbar verbs (Save is a direct module call; the rest close
        // over the panel via the handler ref).
        host.commands.register({
          id: 'inputMap.save',
          title: 'Input Map: Save',
          execute: () => {
            void host.commands.execute('editor.save');
            return done();
          },
        }),
        host.commands.register({ id: 'inputMap.addAction', title: 'Input Map: Add Action', when: () => getInputMapCommandActions() != null, execute: () => { getInputMapCommandActions()?.addAction(); return done(); } }),
        host.commands.register({ id: 'inputMap.import', title: 'Input Map: Import JSON', when: () => getInputMapCommandActions() != null, execute: () => { getInputMapCommandActions()?.triggerImport(); return done(); } }),
        host.commands.register({ id: 'inputMap.export', title: 'Input Map: Export JSON', when: () => getInputMapCommandActions() != null, execute: () => { getInputMapCommandActions()?.exportJson(); return done(); } }),

        ctx.contributePanelActions([
          // Material (asset-properties is shared across kinds → gate on kind).
          // Three flat buttons pinned to the header-left; AssetPreviewMaterial
          // adds the search control at order 40.
          { id: 'material.save.action', panelId: 'asset-properties', command: 'material.save', title: 'Save Material', icon: 'Save', testId: 'material-save', location: 'header/left', order: 10, pinned: true, when: 'panel.asset-properties.kind == "material"', enablement: 'panel.asset-properties.materialDirty' },
          { id: 'material.expandAll.action', panelId: 'asset-properties', command: 'material.expandAll', title: 'Expand All', icon: 'ChevronsUpDown', testId: 'material-expand-all', location: 'header/left', order: 20, pinned: true, when: 'panel.asset-properties.kind == "material"' },
          { id: 'material.collapseAll.action', panelId: 'asset-properties', command: 'material.collapseAll', title: 'Collapse All', icon: 'ChevronsDownUp', testId: 'material-collapse-all', location: 'header/left', order: 30, pinned: true, when: 'panel.asset-properties.kind == "material"' },

          // Material Instance
          { id: 'materialInstance.saveSibling.action', panelId: 'mi-properties', command: 'materialInstance.saveSibling', title: 'Save Sibling', icon: 'Copy', testId: 'mi-save-sibling', location: 'header/right', order: 10, enablement: 'panel.mi-properties.mounted' },
          { id: 'materialInstance.saveChild.action', panelId: 'mi-properties', command: 'materialInstance.saveChild', title: 'Save Child', icon: 'FolderPlus', testId: 'mi-save-child', location: 'header/right', order: 20, enablement: 'panel.mi-properties.mounted' },

          // Input Map
          { id: 'inputMap.save.action', panelId: 'input-map-properties', command: 'inputMap.save', title: 'Save', icon: 'Save', testId: 'input-map-save', location: 'header/right', order: 10, enablement: 'panel.input-map-properties.canSave' },
          { id: 'inputMap.addAction.action', panelId: 'input-map-properties', command: 'inputMap.addAction', title: 'Add Action', icon: 'Plus', testId: 'input-map-add-action', location: 'header/right', order: 20, enablement: 'panel.input-map-properties.mounted' },
          { id: 'inputMap.import.action', panelId: 'input-map-properties', command: 'inputMap.import', title: 'Import JSON', icon: 'Upload', testId: 'input-map-import', location: 'header/right', order: 30, enablement: 'panel.input-map-properties.mounted' },
          { id: 'inputMap.export.action', panelId: 'input-map-properties', command: 'inputMap.export', title: 'Export JSON', icon: 'Download', testId: 'input-map-export', location: 'header/right', order: 40, enablement: 'panel.input-map-properties.mounted' },
        ]),

        subscribeActiveEditorAsset(() => syncAssetEditorsContext(host)),
        subscribeMaterialStaging(() => syncAssetEditorsContext(host)),
        subscribeInputMapStaging(() => syncAssetEditorsContext(host)),
      ];

      return () => {
        for (const key of CONTEXT_KEYS) host.contextKeys.set(key, undefined);
        for (const cleanup of cleanups.slice().reverse()) cleanup();
      };
    },
  };
}
