// Editor callback contract for createEditorKeyboardExtension. Hosts supply one
// instance per application; the extension owns commands and keyboard policy,
// while these callbacks retain the existing Gateway and viewport write paths.
// Contextual F2/Delete/Mod+A remain owned by focused widget contributions.

export { createEditorKeyboardExtension } from './editor-keyboard-extension';

import {
  gateway,
  getSelectionList,
  getAssetSelectionList,
  getLastSelectionDomain,
  getViewportRuntimeClientSnapshot,
  getViewportRuntimeSelectionSnapshot,
  deleteManyCascade,
  duplicateEntity,
  hideMany,
  hideUnselected,
  showAllHidden,
  worldRootHandles,
  childrenOf,
  trySaveActivePage,
  materializeGeneratedDefaultScene,
} from '@forgeax/editor-core';
import { getViewportQuadrant, getInputTarget } from './viewport/viewport-quadrant';
import { routeViewportKeydown } from './viewport/viewport';
import type { InputTarget } from './viewport/viewport-camera';
import { createHumanSaveRequest } from './save-operation-projection';
import { trySaveDirtyMaterialStaging } from './page-controllers/material-page-controller';

/** Asset identity needed by the Editor duplicate shortcut. */
export interface RouterAsset {
  guid: string;
  name: string;
  packPath: string;
}

/** Editor-owned inputs; no product shell types or module-global dependency slot. */
export interface KeyboardRouterDepsShape {
  executeFocusedTextEditAction?: (action: 'undo' | 'redo' | 'delete') => Promise<boolean>;
  dispatch: (op: { kind: string; [k: string]: unknown }, origin?: string) => void;
  getEntitySelection: () => number[];
  getAssetSelection: () => RouterAsset[];
  getLastSelectionDomain: () => 'entity' | 'asset' | 'folder' | null;
  isPlayMode: () => boolean;
  getDisplay: () => 'scene' | 'game';
  getInputTarget: () => InputTarget;
  deleteEntities: (ids: number[]) => void;
  duplicateEntities: (ids: number[]) => void;
  hideEntities: (ids: number[]) => void;
  showAllHidden: () => void;
  hideUnselected: () => void;
  selectAllEntities: () => void;
  duplicateAsset: (guid: string, packPath: string) => void;
  undo: () => void;
  redo: () => void;
  /** Start the canonical save and expose its terminal success to the caller. */
  save: () => void | Promise<boolean>;
  restartPreview: () => void;
  handleViewportKeyDown: (event: KeyboardEvent) => void;
}

/** Build the Gateway-backed callbacks shared by standalone and embedded hosts. */
export function buildKeyboardRouterDeps(): KeyboardRouterDepsShape {
  const readLiveEntitySelection = (): number[] =>
    Array.from(getSelectionList()) as unknown as number[];
  return {
    dispatch: (op: { kind: string; [k: string]: unknown }, origin?: string) =>
      gateway.dispatch(op as never, (origin ?? 'human') as never),
    getEntitySelection: () => {
      const live = readLiveEntitySelection();
      // Viewport picks update the Runtime selection store immediately; the shell
      // snapshot refreshes only after dispatchActiveEditorOperation selection ops.
      if (live.length > 0) return live;
      if (getViewportRuntimeClientSnapshot().status !== 'ready') return live;
      return getViewportRuntimeSelectionSnapshot().entityIds.slice() as number[];
    },
    getAssetSelection: () => {
      const liveAssets = getAssetSelectionList();
      if (liveAssets.length > 0) {
        return liveAssets.map((asset) => ({ ...asset }));
      }
      if (getViewportRuntimeClientSnapshot().status !== 'ready') return liveAssets;
      return getViewportRuntimeSelectionSnapshot().assets.map((asset) => ({ ...asset }));
    },
    getLastSelectionDomain: () => {
      if (readLiveEntitySelection().length > 0) return 'entity';
      if (getAssetSelectionList().length > 0) return 'asset';
      if (getViewportRuntimeClientSnapshot().status !== 'ready') return getLastSelectionDomain();
      return getViewportRuntimeSelectionSnapshot().lastDomain ?? getLastSelectionDomain();
    },
    // Play owns a fresh transient world; gateway.mode still reflects the
    // persistent edit document during that session. The viewport quadrant is the
    // authoritative lifecycle state used by the keyboard router.
    isPlayMode: () => getViewportQuadrant().run === 'play',
    getDisplay: () => getViewportQuadrant().display,
    getInputTarget: () => getInputTarget(),
    restartPreview: () => {
      const retryWhenStopped = (deadline: number): void => {
        if (gateway.playPhase === 'edit' || gateway.playPhase === 'failed') {
          gateway.dispatch({ kind: 'play' }, 'human');
          return;
        }
        if (Date.now() < deadline) window.setTimeout(() => retryWhenStopped(deadline), 50);
      };
      if (gateway.playPhase === 'play' || gateway.playPhase === 'starting') {
        gateway.dispatch({ kind: 'stop' }, 'human');
        retryWhenStopped(Date.now() + 10_000);
        return;
      }
      gateway.dispatch({ kind: 'play' }, 'human');
    },
    deleteEntities: (ids: number[]) => deleteManyCascade(ids as never),
    duplicateEntities: (ids: number[]) => ids.forEach((id) => duplicateEntity(id as never)),
    // UE-parity editor hide (.forgeax-harness/docs/2026-08-04-editor-hide-ue-parity-plan M2) —
    // the shared core ops dispatch the same setVisibility op a panel or AI would,
    // multi-entity gestures wrapped as ONE transaction (one undo step).
    hideEntities: (ids: number[]) => hideMany(ids as never),
    showAllHidden: () => showAllHidden(),
    hideUnselected: () => hideUnselected(getSelectionList() as never),
    selectAllEntities: () => {
      const world = gateway.doc.world;
      const seen = new Set<number>();
      const stack: number[] = [...(worldRootHandles(world) as unknown as number[])];
      const all: number[] = [];
      for (const handle of stack) seen.add(handle);
      while (stack.length > 0) {
        const handle = stack.pop()!;
        all.push(handle);
        for (const child of childrenOf(world, handle as never) as unknown as number[]) {
          if (!seen.has(child)) {
            seen.add(child);
            stack.push(child);
          }
        }
      }
      gateway.dispatch({ kind: 'setSelectionMany', ids: all } as never);
    },
    // Both asset mutations route through the ONE gateway door (G-4): duplicate and
    // rename are DOCUMENT ops (undoable) — the applier reaches pack IO through
    // ctx.assetIO and fires broadcastAssetsChanged itself, so no direct facade call
    // nor manual broadcast here (AI-equal: an AI dispatches the same op).
    duplicateAsset: (guid: string, packPath: string) => {
      gateway.dispatch({ kind: 'duplicateAsset', packPath, guid } as never, 'human');
    },
    undo: () => { gateway.undo(); },
    redo: () => { gateway.redo(); },
    // M4/B3: MI (and future page controllers) divert Ctrl+S away from scene save.
    save: (): Promise<boolean> | undefined => {
      const activePageHandled = trySaveActivePage();
      console.info('[editor] save entry', { activePageHandled });
      if (activePageHandled) return;
      const stagingHandled = trySaveDirtyMaterialStaging();
      if (stagingHandled) {
        console.info('[editor] save handled by material staging');
        return;
      }
      const authoringSession = gateway.sceneAuthoringSession();
      const sceneReadModel = gateway.sceneReadModel();
      console.info('[editor] save state', {
        authoringMode: authoringSession.mode,
        currentScene: sceneReadModel.currentScene,
        defaultScene: sceneReadModel.defaultScene,
      });
      // A script-generated default has no current authored scene entry. Promote
      // it through the canonical createSceneFile transaction before attempting
      // the ordinary pack save; direct disk materialization is intentionally
      // rejected because it cannot publish the external dependency closure.
      if (
        authoringSession.mode === 'authored'
        && sceneReadModel.currentScene === null
      ) {
        console.info('[editor] Ctrl+S promoting script-generated scene to authored pack');
        return materializeGeneratedDefaultScene().then((ok) => {
          console.info('[editor] script-generated scene promotion result', JSON.stringify({ ok }));
          return ok;
        });
      }
      const request = createHumanSaveRequest();
      const accepted = gateway.dispatch(request as never, 'human');
      if (!accepted.ok) return Promise.resolve(false);
      return gateway.waitOperationRun(request.requestId!).then(async (terminal) => {
        if (
          terminal.ok
          && terminal.value.status === 'failed'
          && terminal.value.error?.code === 'generated-scene-read-only'
        ) {
          return materializeGeneratedDefaultScene();
        }
        return terminal.ok && terminal.value.status === 'succeeded';
      });
    },
    handleViewportKeyDown: routeViewportKeydown,
  };
}
