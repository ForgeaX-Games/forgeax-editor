// Shared keyboard-router deps builder (keyboard-router convergence, M4).
//
// The interface submodule's global-shortcuts router is editor-AGNOSTIC (its lint
// forbids importing @forgeax/editor), so every editor host injects the editor-side
// callbacks it still needs via `registerKeyboardRouterDeps(...)`. Contextual
// F2/Delete/Mod+A ownership has moved to focused widget scopes; this bridge now
// carries only the not-yet-migrated edit/viewport shortcuts.
//
// This builder is the SSOT for that dep object. BOTH hosts call it:
//   - editor standalone (apps/standalone/main.tsx)
//   - studio (packages/studio/src/panels/editorRenderers.tsx)
// Previously it lived only in apps/standalone/main.tsx; studio's editorRenderers.tsx
// (which "mirrors" standalone) silently omitted it, so in the studio host the G /
// Esc display-toggle keyboard path was dead — the only pop-out-to-edit path left
// was the GameOverlay hover button. Extracting here removes that divergence.
//
// NOTE: this module deliberately does NOT import @forgeax/interface — it returns a
// structurally-typed object and each host casts it to interface's KeyboardRouterDeps
// at the registerKeyboardRouterDeps call site (where interface is already imported).
// That keeps edit-runtime free of an upward dependency on the L1 framework.

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
} from '@forgeax/editor-core';
import { getViewportQuadrant, getInputTarget } from './viewport/viewport-quadrant';
import { routeViewportKeydown } from './viewport/viewport';
import type { InputTarget } from './viewport/viewport-camera';
import { createHumanSaveRequest } from './save-operation-projection';

/** Minimal asset shape the router hands back for delete/dup/rename. */
export interface RouterAsset {
  guid: string;
  name: string;
  packPath: string;
}

/**
 * Structural mirror of interface's `KeyboardRouterDeps` (global-shortcuts.ts).
 * Declared locally so this module needs NO @forgeax/interface import (keeps
 * edit-runtime off the L1 framework). Hosts cast the returned object to the real
 * interface type at their registerKeyboardRouterDeps call site — the field set is
 * verified identical across the editor + studio interface pins. An explicit type
 * is also required here to avoid TS2742 (inferred type would leak an editor-core
 * internal path).
 */
export interface KeyboardRouterDepsShape {
  dispatch: (op: { kind: string; [k: string]: unknown }, origin?: string) => void;
  getEntitySelection: () => number[];
  getAssetSelection: () => RouterAsset[];
  getLastSelectionDomain: () => 'entity' | 'asset' | 'folder' | null;
  isPlayMode: () => boolean;
  getDisplay: () => 'scene' | 'game';
  // Real editor value is 'editor' | 'game' (interface's KeyboardRouterDeps types
  // this loosely as 'scene' | 'game', but the router only tests === 'game', so the
  // other label is irrelevant). Honest type here; the host `as` cast bridges it.
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
  save: () => void;
  handleViewportKeyDown: (event: KeyboardEvent) => void;
}

/**
 * Build the editor-side keyboard-router deps. The return value is structurally
 * compatible with interface's `KeyboardRouterDeps`; cast at the call site.
 */
export function buildKeyboardRouterDeps(): KeyboardRouterDepsShape {
  const runtimeSelection = () => getViewportRuntimeClientSnapshot().status === 'ready'
    ? getViewportRuntimeSelectionSnapshot()
    : null;
  return {
    dispatch: (op: { kind: string; [k: string]: unknown }, origin?: string) =>
      gateway.dispatch(op as never, (origin ?? 'human') as never),
    getEntitySelection: () => runtimeSelection()?.entityIds.slice()
      ?? Array.from(getSelectionList()) as unknown as number[],
    getAssetSelection: () => runtimeSelection()?.assets.map((asset) => ({ ...asset }))
      ?? getAssetSelectionList(),
    getLastSelectionDomain: () => runtimeSelection()?.lastDomain ?? getLastSelectionDomain(),
    // Play owns a fresh transient world; gateway.mode still reflects the
    // persistent edit document during that session. The viewport quadrant is the
    // authoritative lifecycle state used by the keyboard router.
    isPlayMode: () => getViewportQuadrant().run === 'play',
    getDisplay: () => getViewportQuadrant().display,
    getInputTarget: () => getInputTarget(),
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
    save: () => {
      if (trySaveActivePage()) return;
      gateway.dispatch(createHumanSaveRequest(), 'human');
    },
    handleViewportKeyDown: routeViewportKeydown,
  };
}
