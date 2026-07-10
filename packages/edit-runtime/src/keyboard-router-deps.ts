// Shared keyboard-router deps builder (keyboard-router convergence, M4).
//
// The interface submodule's global-shortcuts router is editor-AGNOSTIC (its lint
// forbids importing @forgeax/editor), so every editor host injects the editor-side
// callbacks it needs via `registerKeyboardRouterDeps(...)` — routing
// Delete/Backspace/F2/Ctrl+D/Ctrl+A/G through the one gateway door while keeping a
// SINGLE global keydown listener (G-1 / AC-A1).
//
// This builder is the SSOT for that dep object. BOTH hosts call it:
//   - editor standalone (packages/editor/standalone/main.tsx)
//   - studio (packages/studio/src/panels/editorRenderers.tsx)
// Previously it lived only in standalone/main.tsx; studio's editorRenderers.tsx
// (which "mirrors" standalone) silently omitted it, so in the studio host the G /
// Esc display-toggle keyboard path was dead — the only pop-out-to-edit path left
// was the GameOverlay hover button. Extracting here removes that divergence.
//
// The ONLY host-specific piece is the risky-multi-delete confirm dialog (a UI-layer
// concern — core stays headless). It is injected via `opts.confirmDeleteAssets`;
// standalone supplies its DeleteGuardDialog bus, studio supplies its own.
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
  getFolderSelectionList,
  deleteManyCascade,
  duplicateEntity,
  worldRootHandles,
  childrenOf,
  triggerAssetSelectAll,
} from '@forgeax/editor-core';
import { getViewportQuadrant, getInputTarget } from './viewport/viewport-quadrant';
import type { InputTarget } from './viewport/viewport-camera';

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
  renameEntity: (id: number) => void;
  selectAllEntities: () => void;
  deleteAssets: (assets: RouterAsset[]) => void;
  duplicateAsset: (guid: string, packPath: string) => void;
  renameAsset: (guid: string, packPath: string) => void;
  selectAllAssets: () => void;
  getFolderSelection?: () => { path: string }[];
  deleteFolders?: (folders: { path: string }[]) => void;
}

export interface BuildKeyboardRouterDepsOptions {
  /**
   * Host-supplied confirm gate for a risky MULTI-asset delete (>1). Resolves true
   * to proceed, false to cancel. Single-asset deletes never call this (they match
   * entity-delete, which has no confirm). UI-layer concern — core stays headless.
   */
  confirmDeleteAssets: (assets: RouterAsset[]) => Promise<boolean>;
}

/**
 * Build the editor-side keyboard-router deps. The return value is structurally
 * compatible with interface's `KeyboardRouterDeps`; cast at the call site.
 */
export function buildKeyboardRouterDeps(opts: BuildKeyboardRouterDepsOptions): KeyboardRouterDepsShape {
  return {
    dispatch: (op: { kind: string; [k: string]: unknown }, origin?: string) =>
      gateway.dispatch(op as never, (origin ?? 'human') as never),
    getEntitySelection: () => Array.from(getSelectionList()) as unknown as number[],
    getAssetSelection: () => getAssetSelectionList(),
    getLastSelectionDomain: () => getLastSelectionDomain(),
    isPlayMode: () => gateway.mode === 'play',
    getDisplay: () => getViewportQuadrant().display,
    getInputTarget: () => getInputTarget(),
    deleteEntities: (ids: number[]) => deleteManyCascade(ids as never),
    duplicateEntities: (ids: number[]) => ids.forEach((id) => duplicateEntity(id as never)),
    renameEntity: (id: number) => gateway.dispatch({ kind: 'requestRename', entity: id } as never),
    selectAllEntities: () => {
      const world = gateway.doc.world;
      const seen = new Set<number>();
      const stack: number[] = [...(worldRootHandles(world) as unknown as number[])];
      const all: number[] = [];
      for (const h of stack) seen.add(h);
      while (stack.length) {
        const h = stack.pop()!;
        all.push(h);
        for (const c of childrenOf(world, h as never) as unknown as number[]) {
          if (!seen.has(c)) { seen.add(c); stack.push(c); }
        }
      }
      gateway.dispatch({ kind: 'setSelectionMany', ids: all } as never);
    },
    deleteAssets: (assets: RouterAsset[]) => {
      // Risky multi-asset delete surfaces the host confirm dialog; single-asset
      // deletes proceed directly (matching entity-delete, no confirm).
      if (assets.length > 1) {
        void opts.confirmDeleteAssets(
          assets.map((a) => ({ guid: a.guid, name: a.name, packPath: a.packPath })),
        ).then((ok) => {
          if (!ok) return;
          for (const a of assets) {
            gateway.dispatch({ kind: 'destroyAsset', packPath: a.packPath, guid: a.guid } as never, 'human');
          }
        });
        return;
      }
      for (const a of assets) {
        gateway.dispatch({ kind: 'destroyAsset', packPath: a.packPath, guid: a.guid } as never, 'human');
      }
    },
    // Both asset mutations route through the ONE gateway door (G-4): duplicate and
    // rename are DOCUMENT ops (undoable) — the applier reaches pack IO through
    // ctx.assetIO and fires broadcastAssetsChanged itself, so no direct facade call
    // nor manual broadcast here (AI-equal: an AI dispatches the same op).
    duplicateAsset: (guid: string, packPath: string) => {
      gateway.dispatch({ kind: 'duplicateAsset', packPath, guid } as never, 'human');
    },
    renameAsset: (guid: string, packPath: string) => {
      const newName = window.prompt('Rename asset:', packPath.split('/').pop() ?? guid);
      if (newName && newName.trim()) {
        gateway.dispatch({ kind: 'renameAsset', packPath, guid, newName: newName.trim() } as never, 'human');
      }
    },
    selectAllAssets: () => triggerAssetSelectAll(),
    getFolderSelection: () => getFolderSelectionList().map((p) => ({ path: p })),
    deleteFolders: (folders) => {
      for (const f of folders) {
        if (!window.confirm(`Delete folder "${f.path}" and all its contents?`)) return;
        gateway.dispatch({ kind: 'deleteDirectory', path: f.path } as never, 'human');
      }
    },
  };
}
