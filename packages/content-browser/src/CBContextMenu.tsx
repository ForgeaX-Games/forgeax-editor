import { type CBAsset, type CBFolder, type CBSelection } from './types';
// M3 (AC-03): asset assignment (setComponent) and asset-selection (a transient
// op) go through the one gateway door — gateway.dispatch({ kind, … }) — replacing the
// direct setAssetSelection setter and the origin-less `dispatch` wrapper.
import {
  requestAddAssetsToChat, requestAddAssetToScene, type AssetChatRef,
  deleteAsset, broadcastAssetsChanged,
  gateway, getSelection,
} from '@forgeax/editor-core';

/** Map an asset kind to the component patch that assigns it onto an entity. */
function assignPatchForKind(kind: string, guid: string): { component: string; patch: Record<string, unknown> } | null {
  if (kind === 'material') return { component: 'Material', patch: { materialAsset: guid } };
  if (kind === 'mesh') return { component: 'Mesh', patch: { meshAsset: guid } };
  if (kind === 'texture' || kind === 'image') return { component: 'Material', patch: { albedoMap: guid } };
  return null;
}

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  disabled?: boolean;
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
    { id: 'rename', label: 'Rename', shortcut: 'F2', action: () => {
      if (callbacks?.onRename) {
        callbacks.onRename(asset);
      } else {
        const newName = window.prompt('Rename asset:', asset.name);
        if (newName && newName !== asset.name) {
          // D6: rename routes through the ONE gateway door (document op, undoable).
          // The applier reaches pack IO via ctx.assetIO and fires the in-process
          // assetsChanged notification itself; Content Browser reloads from it.
          gateway.dispatch({ kind: 'renameAsset', packPath: asset.packPath, guid: asset.guid, newName, oldName: asset.name }, 'human');
        }
      }
    }},
    { id: 'duplicate', label: 'Duplicate', shortcut: 'Ctrl+D', action: () => {
      for (const a of targets) {
        // D6: duplicate routes through the gateway (document op, undoable). The new
        // guid is allocated inside the applier's assetIO gate; no direct facade call.
        gateway.dispatch({ kind: 'duplicateAsset', packPath: a.packPath, guid: a.guid }, 'human');
      }
    }},
    { id: 'delete', label: 'Delete', shortcut: 'Del', action: () => {
      if (callbacks?.onDelete) { callbacks.onDelete(targets); return; }
      // Fallback for hosts without a delete guard wired in.
      const names = targets.map(a => a.name).join(', ');
      if (!window.confirm(`Delete ${targets.length} asset(s)?\n${names}`)) return;
      for (const a of targets) {
        void deleteAsset(a.packPath, a.guid).then(ok => {
          if (ok) { broadcastAssetsChanged(); callbacks?.onReload?.(); }
        });
      }
    }},
    { id: 'sep-1', label: '', separator: true, action: () => {} },

    // ── References ──
    { id: 'copy-guid', label: 'Copy GUID', action: () => {
      void navigator.clipboard.writeText(targets.map(a => a.guid).join('\n'));
    }},
    { id: 'copy-path', label: 'Copy Asset Path', shortcut: 'Ctrl+Shift+C', action: () => {
      void navigator.clipboard.writeText(targets.map(a => a.packPath).join('\n'));
    }},
    { id: 'sep-2', label: '', separator: true, action: () => {} },

    // ── Scene ──
    { id: 'add-to-scene', label: 'Add to Scene', action: () => {
      const ref: AssetChatRef = { type: 'asset', guid: asset.guid, kind: asset.kind, name: asset.name, path: asset.packPath, payload: asset.payload };
      console.info('[CB:import] Add to Scene', { kind: ref.kind, guid: ref.guid, name: ref.name, path: ref.path });
      requestAddAssetToScene(ref);
    }},
    { id: 'assign', label: 'Assign to Selected Entity', action: () => {
      const sel = getSelection();
      const mapping = assignPatchForKind(asset.kind, asset.guid);
      // With an entity selected AND an assignable kind → actually patch the
      // component. Otherwise fall back to publishing the asset selection (so the
      // Inspector / Material panel can pick it up).
      if (sel !== null && mapping) {
        gateway.dispatch({ kind: 'setComponent', entity: sel, component: mapping.component, patch: mapping.patch });
      } else {
        // M1 (AC-B2): single-asset select uses the setAssetSelectionOne
        // sugar op (forwards to the multi-base setAssetSelection applier).
        gateway.dispatch({ kind: 'setAssetSelectionOne', asset: { guid: asset.guid, kind: asset.kind, name: asset.name, payload: asset.payload, packPath: asset.packPath } });
      }
    }},
    { id: 'sep-3', label: '', separator: true, action: () => {} },

    // ── AI ──
    { id: 'add-to-chat', label: '🤖 Add to AI Chat', action: () => {
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
    { id: 'add-with-deps', label: '🤖 Add with Dependencies', action: () => {
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
    { id: 'open', label: 'Open', action: () => { /* handled by caller via navigate */ } },
    { id: 'new-folder', label: 'New Folder', action: () => {
      callbacks?.onNewFolder?.(folder.path);
    }},
    { id: 'sep-1', label: '', separator: true, action: () => {} },

    { id: 'rename', label: 'Rename', shortcut: 'F2', action: () => { /* folder rename needs server move API */ } },
    { id: 'delete', label: 'Delete', shortcut: 'Del', action: () => {
      if (!window.confirm(`Delete folder "${folder.name}" and all its contents?`)) return;
      gateway.dispatch({ kind: 'deleteDirectory', path: folder.path }, 'human');
    }},
    { id: 'copy-path', label: 'Copy Path', action: () => {
      void navigator.clipboard.writeText(folder.path);
    }},
    { id: 'sep-2', label: '', separator: true, action: () => {} },

    // ── Favorites ──
    { id: 'toggle-fav', label: folder.isFavorite ? 'Remove from Favorites' : 'Add to Favorites', action: () => { /* handled by caller */ } },
    { id: 'sep-3', label: '', separator: true, action: () => {} },

    // ── AI ──
    { id: 'add-folder-chat', label: '🤖 Add Folder to AI Chat', action: () => {
      const kinds: Record<string, number> = {};
      for (const a of assetsInFolder) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
      requestAddAssetsToChat([{
        type: 'folder',
        name: folder.name,
        path: folder.path,
        summary: { totalAssets: assetsInFolder.length, kinds, guids: assetsInFolder.map(a => a.guid) },
      }]);
    }},
    { id: 'add-folder-summary', label: '🤖 Add Folder Summary to Chat', action: () => {
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
      label: 'New Folder',
      action: () => onCreateDirectory(currentPath),
    },
  ];
}
