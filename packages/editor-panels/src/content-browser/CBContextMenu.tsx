import { type CBAsset, type CBFolder, type CBSelection } from './types';
import { setAssetSelection, requestRefAsset } from '@forgeax/editor-shared';

export interface ContextMenuPosition {
  x: number;
  y: number;
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

export function buildAssetContextMenu(
  asset: CBAsset,
  selection: CBSelection,
  allAssets: CBAsset[],
): ContextMenuItem[] {
  const selectedAssets = getAssetsInSelection(selection);
  const targets = selectedAssets.length > 1 ? selectedAssets : [asset];

  return [
    // ── Common ──
    { id: 'rename', label: 'Rename', shortcut: 'F2', action: () => { /* M2 */ } },
    { id: 'duplicate', label: 'Duplicate', shortcut: 'Ctrl+D', action: () => { /* M2 */ } },
    { id: 'delete', label: 'Delete', shortcut: 'Del', action: () => { /* M2 */ } },
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
    { id: 'assign', label: 'Assign to Selected Entity', action: () => {
      setAssetSelection({ guid: asset.guid, kind: asset.kind, name: asset.name, payload: asset.payload, packPath: asset.packPath });
    }},
    { id: 'sep-3', label: '', separator: true, action: () => {} },

    // ── AI ──
    { id: 'add-to-chat', label: '🤖 Add to AI Chat', action: () => {
      for (const a of targets) {
        requestRefAsset({ guid: a.guid, kind: a.kind, name: a.name, packPath: a.packPath });
      }
      // M5: batch addAssetToChat with full payload via dedicated protocol message
    }},
    { id: 'add-with-deps', label: '🤖 Add with Dependencies', action: () => {
      const visited = new Set<string>();
      for (const a of targets) {
        if (visited.has(a.guid)) continue;
        visited.add(a.guid);
        requestRefAsset({ guid: a.guid, kind: a.kind, name: a.name, packPath: a.packPath });
        for (const refGuid of a.refs) {
          if (visited.has(refGuid)) continue;
          visited.add(refGuid);
          const dep = allAssets.find(x => x.guid === refGuid);
          if (dep) requestRefAsset({ guid: dep.guid, kind: dep.kind, name: dep.name, packPath: dep.packPath });
        }
      }
      // M5: batch addAssetToChat with payload + dependency graph
    }},
  ];
}

export function buildFolderContextMenu(
  folder: CBFolder,
  assetsInFolder: CBAsset[],
): ContextMenuItem[] {
  return [
    // ── Folder ──
    { id: 'open', label: 'Open', action: () => { /* handled by caller via navigate */ } },
    { id: 'new-folder', label: 'New Folder', action: () => { /* M2 */ } },
    { id: 'sep-1', label: '', separator: true, action: () => {} },

    { id: 'rename', label: 'Rename', shortcut: 'F2', action: () => { /* M2 */ } },
    { id: 'delete', label: 'Delete', shortcut: 'Del', action: () => { /* M2 */ } },
    { id: 'copy-path', label: 'Copy Path', action: () => {
      void navigator.clipboard.writeText(folder.path);
    }},
    { id: 'sep-2', label: '', separator: true, action: () => {} },

    // ── Favorites ──
    { id: 'toggle-fav', label: folder.isFavorite ? 'Remove from Favorites' : 'Add to Favorites', action: () => { /* handled by caller */ } },
    { id: 'sep-3', label: '', separator: true, action: () => {} },

    // ── AI ──
    { id: 'add-folder-chat', label: '🤖 Add Folder to AI Chat', action: () => {
      for (const a of assetsInFolder) {
        requestRefAsset({ guid: a.guid, kind: a.kind, name: a.name, packPath: a.packPath });
      }
      // M5: batch addAssetToChat with folder summary via dedicated protocol
    }},
  ];
}
