import { type CBAsset, type CBFolder, type CBSelection } from './types';
// M3 (AC-03): asset assignment goes through the one gateway door via bindAssetRef
// (resolves GUID → shared<T> handle) instead of setComponent with deprecated names.
import {
  requestAddAssetsToChat, requestAddAssetToScene, type AssetChatRef,
  dispatchActiveEditorOperation, gateway, getSelection, validateAssetBasename,
} from '@forgeax/editor-core';
import type { EntityHandle } from '@forgeax/editor-core';
import { t as tr } from '@forgeax/editor-core/i18n';
// Rename fallback still uses the editor-ui prompt modal (only when no host
// onRename callback is supplied). Delete no longer uses the editor-ui confirm —
// it always routes through the host's reliable cb-dialog delete guards
// (onDelete / onDeleteFolder), which paint correctly in the standalone host.
import { isAssetPlacementAvailable } from './content-browser-format';
import { contentBrowserPrompt } from './interaction-surface';
import type { SubjectActionRequest } from './workspace/subject-actions';

/** Assign a catalogued asset to the selected entity via bindAssetRef (GUID→handle).
 *  material/mesh: direct bindAssetRef op. texture/image: createMaterial + bindAssetRef.
 *  Returns true if the asset was assignable (op dispatched), false otherwise. */
function assignAssetToEntity(kind: string, guid: string, name: string, entity: EntityHandle): boolean {
  if (!['material', 'mesh', 'texture', 'image'].includes(kind)) return false;
  void dispatchActiveEditorOperation({
    kind: 'assignAssetToEntity', entity, asset: { guid, kind, name }, requestId: crypto.randomUUID(),
  }, 'human');
  return true;
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

export function dispatchReimportAsset(asset: CBAsset): void {
  const expectedRevision = asset.metaRevision ?? asset.revision;
  if (!asset.sourceKey || !expectedRevision) return;
  void dispatchActiveEditorOperation({
    kind: 'reimportAsset',
    guid: asset.guid,
    scope: { sourceKey: asset.sourceKey },
    expectedRevision,
    requestId: crypto.randomUUID(),
  }, 'human').then((result) => {
    if (!result.ok) console.warn('[content-browser] reimport dispatch rejected', result.error);
  });
}

export interface CRUDCallbacks {
  onSubjectAction?: (request: Omit<SubjectActionRequest, 'snapshot'>) => void;
  onRename?: (asset: CBAsset) => void;
  onNewFolder?: (parentPath: string) => void;
  onReload?: () => void;
  /**
   * Route asset deletion through the host's reference-aware delete guard (C3).
   * The context menu always delegates to this — there is no editor-ui `confirm`
   * fallback, since that AlertDialog never paints in the standalone host (isolated
   * overlay React root) and would hang the delete. Keyboard and menu deletes thus
   * share one reliable guard dialog.
   */
  onDelete?: (targets: CBAsset[]) => void;
  /**
   * Route folder deletion through the host's path-delete guard (reliable
   * cb-dialog modal), mirroring {@link onDelete} for assets. Same rationale:
   * no editor-ui confirm fallback.
   */
  onDeleteFolder?: (folder: { path: string; name: string }) => void;
  onSourceMutation?: (asset: CBAsset) => void;
}

export function buildAssetContextMenu(
  asset: CBAsset,
  selection: CBSelection,
  allAssets: CBAsset[],
  callbacks?: CRUDCallbacks,
  selectedEntity?: EntityHandle | null,
): ContextMenuItem[] {
  const selectedAssets = getAssetsInSelection(selection);
  const targets = selectedAssets.length > 1 ? selectedAssets : [asset];
  const placementAvailable = isAssetPlacementAvailable(asset);

  return [
    // ── Common ──
    { id: 'rename', label: tr('editor.contentBrowser.contextMenu.rename'), shortcut: 'F2', action: () => {
      if (callbacks?.onRename) {
        callbacks.onRename(asset);
      } else {
        void (async () => {
          const newName = await contentBrowserPrompt({
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
            void dispatchActiveEditorOperation({ kind: 'renameAsset', packPath: asset.packPath, guid: asset.guid, newName, oldName: asset.name }, 'human');
          }
        })();
      }
    }},
    { id: 'replace', label: 'Replace asset', action: () => {
      callbacks?.onSubjectAction?.({ operation: 'replace', asset });
    }},
    { id: 'reimport', label: 'Reimport asset', disabled: asset.sourcePath === undefined, action: () => {
      callbacks?.onSourceMutation?.(asset);
    }},
    { id: 'source-mutation', label: 'Source lifecycle', disabled: asset.sourceKey === undefined, action: () => {
      callbacks?.onSourceMutation?.(asset);
    }},
    { id: 'duplicate', label: tr('editor.contentBrowser.contextMenu.duplicate'), shortcut: 'Ctrl+D', action: () => {
      for (const a of targets) {
        // D6: duplicate routes through the gateway (document op, undoable). The new
        // guid is allocated inside the applier's assetIO gate; no direct facade call.
        void dispatchActiveEditorOperation({ kind: 'duplicateAsset', packPath: a.packPath, guid: a.guid }, 'human');
      }
    }},
    { id: 'delete', label: tr('editor.contentBrowser.contextMenu.delete'), shortcut: 'Del', danger: true, action: () => {
      // Always delegate to the host's reference-aware delete guard (reliable
      // cb-dialog modal). No editor-ui confirm fallback — see CRUDCallbacks.onDelete.
      callbacks?.onDelete?.(targets);
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
    { id: 'add-to-scene', label: tr('editor.contentBrowser.contextMenu.addToScene'), disabled: !placementAvailable, action: () => {
      if (!placementAvailable) return;
      const ref: AssetChatRef = { type: 'asset', guid: asset.guid, kind: asset.kind, name: asset.name, path: asset.packPath, payload: asset.payload, authoring: asset.authoring };
      console.info(`[placement-diag] context-menu.request ${JSON.stringify({
        guid: ref.guid,
        kind: ref.kind,
        name: ref.name,
        path: ref.path,
        operation: asset.authoring?.placement.operation ?? 'legacy-fallback',
      })}`);
      console.info('[CB:import] Add to Scene', { kind: ref.kind, guid: ref.guid, name: ref.name, path: ref.path });
      requestAddAssetToScene(ref);
    }},
    { id: 'assign', label: tr('editor.contentBrowser.contextMenu.assignToSelected'), action: () => {
      // Opening an asset context menu publishes the asset selection, which is
      // intentionally an exclusive selection domain and clears the entity
      // selection. Capture the entity before that happens so this menu action
      // still means "assign to the entity I had selected when I opened it".
      const sel = selectedEntity !== undefined ? selectedEntity : getSelection();
      // With an entity selected AND an assignable kind → delegate to assignAssetToEntity
      // (uses bindAssetRef for material/mesh, createMaterial+bindAssetRef for texture/image).
      if (sel !== null && assignAssetToEntity(asset.kind, asset.guid, asset.name, sel)) {
        return;
      }
      // Fall back to publishing the asset selection (so the Inspector / Material panel
      // can pick it up).
      void dispatchActiveEditorOperation({ kind: 'setAssetSelectionOne', asset: { guid: asset.guid, kind: asset.kind, name: asset.name, payload: asset.payload, packPath: asset.packPath } });
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
      // Route through the host's path-delete guard (reliable cb-dialog modal),
      // consistent with asset delete. No editor-ui confirm fallback.
      callbacks?.onDeleteFolder?.({ path: folder.path, name: folder.name });
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

/** One blank-area "create asset" row — caller maps CREATABLE_ASSET_KINDS. */
export interface BlankAreaCreateAssetEntry {
  readonly id: string;
  readonly label: string;
  readonly action: () => void;
}

/** Build context menu for blank area right-click (UE5 Content Browser parity). */
export function buildBlankAreaContextMenu(
  currentPath: string,
  onCreateDirectory: (parentPath: string) => void,
  createAssets: readonly BlankAreaCreateAssetEntry[] = [],
): ContextMenuItem[] {
  return [
    {
      id: 'new-folder',
      label: tr('editor.contentBrowser.contextMenu.newFolder'),
      action: () => onCreateDirectory(currentPath),
    },
    ...createAssets.map((entry) => ({
      id: entry.id,
      label: entry.label,
      action: entry.action,
    })),
  ];
}
