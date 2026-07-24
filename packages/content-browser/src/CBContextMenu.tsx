import { type CBAsset, type CBFolder, type CBSelection } from './types';
// M3 (AC-03): asset assignment goes through the one gateway door via bindAssetRef
// (resolves GUID → shared<T> handle) instead of setComponent with deprecated names.
import {
  requestAddAssetsToChat, requestAddAssetToScene, type AssetChatRef,
  gateway, getSelection, entComponent, validateAssetBasename,
} from '@forgeax/editor-core';
import type { EntityHandle } from '@forgeax/editor-core';
import { t as tr } from '@forgeax/editor-core/i18n';
// Themed overlay modals (editor-ui) replace window.prompt/confirm in the
// fallback branches below (used only when no host CRUD callback is supplied).
import { confirm as confirmDialog, prompt as promptDialog } from '@forgeax/editor-ui';

/** Assign a catalogued asset to the selected entity via bindAssetRef (GUID→handle).
 *  material/mesh: direct bindAssetRef op. texture/image: createMaterial + bindAssetRef.
 *  Returns true if the asset was assignable (op dispatched), false otherwise. */
function assignAssetToEntity(kind: string, guid: string, name: string, entity: EntityHandle): boolean {
  // material → MeshRenderer.materials
  if (kind === 'material') {
    gateway.dispatch({
      kind: 'bindAssetRef', entity,
      component: 'MeshRenderer', field: 'materials',
      assetType: 'MaterialAsset', guids: [guid],
    }, 'human');
    return true;
  }
  // mesh → MeshFilter.assetHandle
  if (kind === 'mesh') {
    gateway.dispatch({
      kind: 'bindAssetRef', entity,
      component: 'MeshFilter', field: 'assetHandle',
      assetType: 'MeshAsset', guids: [guid],
    }, 'human');
    return true;
  }
  // texture/image → createMaterial + bindAssetRef (Task 3 & Task 5)
  if (kind === 'texture' || kind === 'image') {
    // Ensure the entity has MeshRenderer (bindAssetRef requires it)
    const mr = entComponent(gateway.activeWorld, entity, 'MeshRenderer');
    if (!mr.ok) {
      gateway.dispatch({ kind: 'addComponent', entity, component: 'MeshRenderer', value: { materials: [] } }, 'human');
    }
    const materialGuid = crypto.randomUUID();
    gateway.dispatch({
      kind: 'createMaterial',
      guid: materialGuid,
      name: `mat_${name}`,
      baseColor: [1, 1, 1, 1],
      baseColorTexture: guid,
    }, 'human');
    gateway.dispatch({
      kind: 'bindAssetRef', entity,
      component: 'MeshRenderer', field: 'materials',
      assetType: 'MaterialAsset', guids: [materialGuid],
    }, 'human');
    return true;
  }
  return false;
}

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  forge?: boolean;
  separator?: boolean;
  action: () => void;
}

function getAssetsInSelection(selection: CBSelection): CBAsset[] {
  return selection.items.filter((i): i is CBAsset => i.type === 'asset');
}

export interface CRUDCallbacks {
  onRename?: (asset: CBAsset) => void;
  onNewFolder?: (parentPath: string) => void;
  onReload?: () => void;
  /**
   * Route deletion through the host's reference-aware delete guard (C3).
   * When provided, the context menu delegates instead of running its own
   * `window.confirm`, so keyboard and menu deletes share one guard dialog.
   */
  onDelete?: (targets: CBAsset[]) => void;
}

export function buildAssetContextMenu(
  asset: CBAsset,
  selection: CBSelection,
  allAssets: CBAsset[],
  callbacks?: CRUDCallbacks,
): ContextMenuItem[] {
  const selectedAssets = getAssetsInSelection(selection);
  const targets = selectedAssets.length > 1 ? selectedAssets : [asset];

  return [
    // ── Common ──
    { id: 'rename', label: tr('editor.contentBrowser.contextMenu.rename'), shortcut: 'F2', action: () => {
      if (callbacks?.onRename) {
        callbacks.onRename(asset);
      } else {
        void (async () => {
          const newName = await promptDialog({
            title: tr('editor.contentBrowser.contextMenu.rename'),
            label: tr('editor.contentBrowser.dialogs.renameAssetPrompt'),
            defaultValue: asset.name,
            confirmText: tr('editor.contentBrowser.dialogs.ok'),
            cancelText: tr('editor.contentBrowser.dialogs.cancel'),
            // Same SSOT the applier enforces; dialog Confirm disables while
            // invalid so the user gets red text instead of a silent reject.
            validate: (v) => {
              const r = validateAssetBasename(v);
              return r.ok ? null : r.hint;
            },
          });
          if (newName && newName !== asset.name) {
            // D6: rename routes through the ONE gateway door (document op, undoable).
            // The applier reaches pack IO via ctx.assetIO and fires the in-process
            // assetsChanged notification itself; Content Browser reloads from it.
            gateway.dispatch({ kind: 'renameAsset', packPath: asset.packPath, guid: asset.guid, newName, oldName: asset.name }, 'human');
          }
        })();
      }
    }},
    { id: 'duplicate', label: tr('editor.contentBrowser.contextMenu.duplicate'), shortcut: 'Ctrl+D', action: () => {
      for (const a of targets) {
        // D6: duplicate routes through the gateway (document op, undoable). The new
        // guid is allocated inside the applier's assetIO gate; no direct facade call.
        gateway.dispatch({ kind: 'duplicateAsset', packPath: a.packPath, guid: a.guid }, 'human');
      }
    }},
    { id: 'delete', label: tr('editor.contentBrowser.contextMenu.delete'), shortcut: 'Del', danger: true, action: () => {
      if (callbacks?.onDelete) { callbacks.onDelete(targets); return; }
      void (async () => {
        const names = targets.map(a => a.name).join(', ');
        const ok = await confirmDialog({
          title: tr('editor.contentBrowser.deleteGuard.title', { count: targets.length, plural: targets.length === 1 ? '' : 's' }),
          description: names,
          confirmText: tr('editor.contentBrowser.deleteGuard.confirm'),
          cancelText: tr('editor.contentBrowser.deleteGuard.cancel'),
          destructive: true,
        });
        if (!ok) return;
        for (const a of targets) {
          gateway.dispatch({ kind: 'destroyAsset', packPath: a.packPath, guid: a.guid }, 'human');
        }
      })();
    }},
    { id: 'sep-1', label: '', separator: true, action: () => {} },

    // ── References ──
    { id: 'copy-guid', label: tr('editor.contentBrowser.contextMenu.copyGuid'), action: () => {
      void navigator.clipboard.writeText(targets.map(a => a.guid).join('\n'));
    }},
    { id: 'copy-path', label: tr('editor.contentBrowser.contextMenu.copyAssetPath'), shortcut: 'Ctrl+Shift+C', action: () => {
      void navigator.clipboard.writeText(targets.map(a => a.packPath).join('\n'));
    }},
    { id: 'sep-2', label: '', separator: true, action: () => {} },

    // ── Scene ──
    { id: 'add-to-scene', label: tr('editor.contentBrowser.contextMenu.addToScene'), action: () => {
      const ref: AssetChatRef = { type: 'asset', guid: asset.guid, kind: asset.kind, name: asset.name, path: asset.packPath, payload: asset.payload };
      console.info('[CB:import] Add to Scene', { kind: ref.kind, guid: ref.guid, name: ref.name, path: ref.path });
      requestAddAssetToScene(ref);
    }},
    { id: 'assign', label: tr('editor.contentBrowser.contextMenu.assignToSelected'), action: () => {
      const sel = getSelection();
      // With an entity selected AND an assignable kind → delegate to assignAssetToEntity
      // (uses bindAssetRef for material/mesh, createMaterial+bindAssetRef for texture/image).
      if (sel !== null && assignAssetToEntity(asset.kind, asset.guid, asset.name, sel)) {
        return;
      }
      // Fall back to publishing the asset selection (so the Inspector / Material panel
      // can pick it up).
      gateway.dispatch({ kind: 'setAssetSelectionOne', asset: { guid: asset.guid, kind: asset.kind, name: asset.name, payload: asset.payload, packPath: asset.packPath } });
    }},
    { id: 'sep-3', label: '', separator: true, action: () => {} },

    // ── AI ──
    { id: 'add-to-chat', label: tr('editor.contentBrowser.contextMenu.addToChat'), forge: true, action: () => {
      const refs: AssetChatRef[] = targets.map(a => ({
        type: 'asset' as const,
        guid: a.guid,
        kind: a.kind,
        name: a.name,
        path: a.packPath,
        payload: a.payload,
      }));
      requestAddAssetsToChat(refs);
    }},
    { id: 'add-with-deps', label: tr('editor.contentBrowser.contextMenu.addWithDependencies'), forge: true, action: () => {
      const visited = new Set<string>();
      const refs: AssetChatRef[] = [];
      for (const a of targets) {
        if (visited.has(a.guid)) continue;
        visited.add(a.guid);
        refs.push({ type: 'asset', guid: a.guid, kind: a.kind, name: a.name, path: a.packPath, payload: a.payload });
        for (const refGuid of a.refs) {
          if (visited.has(refGuid)) continue;
          visited.add(refGuid);
          const dep = allAssets.find(x => x.guid === refGuid);
          if (dep) refs.push({ type: 'asset', guid: dep.guid, kind: dep.kind, name: dep.name, path: dep.packPath, payload: dep.payload });
        }
      }
      requestAddAssetsToChat(refs);
    }},
  ];
}

export function buildFolderContextMenu(
  folder: CBFolder,
  assetsInFolder: CBAsset[],
  callbacks?: CRUDCallbacks,
): ContextMenuItem[] {
  return [
    // ── Folder ──
    { id: 'open', label: tr('editor.contentBrowser.contextMenu.open'), action: () => { /* handled by caller via navigate */ } },
    { id: 'new-folder', label: tr('editor.contentBrowser.contextMenu.newFolder'), action: () => {
      callbacks?.onNewFolder?.(folder.path);
    }},
    { id: 'sep-1', label: '', separator: true, action: () => {} },

    { id: 'rename', label: tr('editor.contentBrowser.contextMenu.rename'), shortcut: 'F2', action: () => { /* folder rename needs server move API */ } },
    { id: 'delete', label: tr('editor.contentBrowser.contextMenu.delete'), shortcut: 'Del', danger: true, action: () => {
      void (async () => {
        const ok = await confirmDialog({
          title: tr('editor.contentBrowser.contextMenu.delete'),
          description: tr('editor.contentBrowser.dialogs.deleteFolderConfirm', { name: folder.name }),
          confirmText: tr('editor.contentBrowser.deleteGuard.confirm'),
          cancelText: tr('editor.contentBrowser.deleteGuard.cancel'),
          destructive: true,
        });
        if (!ok) return;
        gateway.dispatch({ kind: 'deleteDirectory', path: folder.path }, 'human');
      })();
    }},
    { id: 'copy-path', label: tr('editor.contentBrowser.contextMenu.copyPath'), action: () => {
      void navigator.clipboard.writeText(folder.path);
    }},
    { id: 'sep-2', label: '', separator: true, action: () => {} },

    // ── Favorites ──
    { id: 'toggle-fav', label: folder.isFavorite ? tr('editor.contentBrowser.contextMenu.unfavorite') : tr('editor.contentBrowser.contextMenu.favorite'), action: () => { /* handled by caller */ } },
    { id: 'sep-3', label: '', separator: true, action: () => {} },

    // ── AI ──
    { id: 'add-folder-chat', label: tr('editor.contentBrowser.contextMenu.addFolderToChat'), forge: true, action: () => {
      const kinds: Record<string, number> = {};
      for (const a of assetsInFolder) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
      requestAddAssetsToChat([{
        type: 'folder',
        name: folder.name,
        path: folder.path,
        summary: { totalAssets: assetsInFolder.length, kinds, guids: assetsInFolder.map(a => a.guid) },
      }]);
    }},
    { id: 'add-folder-summary', label: tr('editor.contentBrowser.contextMenu.addFolderSummaryToChat'), forge: true, action: () => {
      const kinds: Record<string, number> = {};
      for (const a of assetsInFolder) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
      requestAddAssetsToChat([{
        type: 'folder',
        name: folder.name,
        path: folder.path,
        summary: { totalAssets: assetsInFolder.length, kinds, guids: assetsInFolder.map(a => a.guid) },
      }]);
    }},
  ];
}

/** Build context menu for blank area right-click (UE5 Content Browser parity). */
export function buildBlankAreaContextMenu(
  currentPath: string,
  onCreateDirectory: (parentPath: string) => void,
): ContextMenuItem[] {
  return [
    {
      id: 'new-folder',
      label: tr('editor.contentBrowser.contextMenu.newFolder'),
      action: () => onCreateDirectory(currentPath),
    },
  ];
}
