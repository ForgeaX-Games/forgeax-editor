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
  getPathSelectionList,
  getViewportRuntimeClientSnapshot,
  getViewportRuntimeSelectionSnapshot,
  deleteManyCascade,
  duplicateEntity,
  hideMany,
  hideUnselected,
  showAllHidden,
  worldRootHandles,
  childrenOf,
  triggerAssetSelectAll,
  trySaveActivePage,
  type PathSelectionItem,
} from '@forgeax/editor-core';
import { getViewportQuadrant, getInputTarget } from './viewport/viewport-quadrant';
import { routeViewportKeydown } from './viewport/viewport';
import type { InputTarget } from './viewport/viewport-camera';
import { createHumanSaveRequest } from './save-operation-projection';

/** True when a text-editing control (or Input Map panel) owns focus.
 *  Uses tagName (realm-safe) and walks open shadow roots. Host-side callers
 *  still cannot see into cross-origin iframes — shortcut-forwarder must not
 *  forward Delete/Backspace while typing there. */
function isTextFieldFocused(): boolean {
  if (typeof document === 'undefined') return false;
  let el: Element | null = document.activeElement;
  for (;;) {
    const root = el && 'shadowRoot' in el ? (el as HTMLElement).shadowRoot : null;
    const next = root?.activeElement ?? null;
    if (!next || next === el) break;
    el = next;
  }
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden'].includes(type);
  }
  if ((el as HTMLElement).isContentEditable) return true;
  return !!el.closest('.im-editor, [contenteditable="true"]');
}

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
  renameEntity: (id: number) => void;
  selectAllEntities: () => void;
  deleteAssets: (assets: RouterAsset[]) => void;
  duplicateAsset: (guid: string, packPath: string) => void;
  renameAsset: (guid: string, packPath: string) => void;
  selectAllAssets: () => void;
  getFolderSelection?: () => { path: string }[];
  getPathSelection?: () => PathSelectionItem[];
  deleteFolders?: (folders: { path: string }[]) => void;
  deletePathItems?: (items: PathSelectionItem[]) => void;
  undo: () => void;
  redo: () => void;
  save: () => void;
  handleViewportKeyDown: (event: KeyboardEvent) => void;
}

export interface BuildKeyboardRouterDepsOptions {
  /**
   * Host-supplied preflight/confirm gate for every asset delete. Resolves true
   * to proceed, false to cancel. UI-layer concern — core stays headless.
   */
  confirmDeleteAssets: (assets: RouterAsset[]) => Promise<boolean>;
  /** Host-supplied confirm gate for folder deletion. */
  confirmDeleteFolder: (folderPath: string) => Promise<boolean>;
  /** Host-supplied prompt for renaming an asset. Returns null on cancel. */
  promptRenameAsset: (currentName: string) => Promise<string | null>;
}

/**
 * Build the editor-side keyboard-router deps. The return value is structurally
 * compatible with interface's `KeyboardRouterDeps`; cast at the call site.
 */
export function buildKeyboardRouterDeps(opts: BuildKeyboardRouterDepsOptions): KeyboardRouterDepsShape {
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
    // UE-parity editor hide (docs 2026-08-04-editor-hide-ue-parity-plan M2) —
    // the shared core ops dispatch the same setVisibility op a panel or AI would,
    // multi-entity gestures wrapped as ONE transaction (one undo step).
    hideEntities: (ids: number[]) => hideMany(ids as never),
    showAllHidden: () => showAllHidden(),
    hideUnselected: () => hideUnselected(getSelectionList() as never),
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
      // Keyboard Delete uses the same host preflight for one or many targets.
      void opts.confirmDeleteAssets(
        assets.map((a) => ({ guid: a.guid, name: a.name, packPath: a.packPath })),
      ).then((ok) => {
        if (!ok) return;
        for (const a of assets) {
          gateway.dispatch({ kind: 'destroyAsset', guid: a.guid } as never, 'human');
        }
      });
    },
    // Both asset mutations route through the ONE gateway door (G-4): duplicate and
    // rename are DOCUMENT ops (undoable) — the applier reaches pack IO through
    // ctx.assetIO and fires broadcastAssetsChanged itself, so no direct facade call
    // nor manual broadcast here (AI-equal: an AI dispatches the same op).
    duplicateAsset: (guid: string, packPath: string) => {
      gateway.dispatch({ kind: 'duplicateAsset', packPath, guid } as never, 'human');
    },
    renameAsset: (guid: string, packPath: string) => {
      void opts.promptRenameAsset(packPath.split('/').pop() ?? guid).then((newName) => {
        if (newName && newName.trim()) {
          gateway.dispatch({ kind: 'renameAsset', packPath, guid, newName: newName.trim() } as never, 'human');
        }
      });
    },
    selectAllAssets: () => triggerAssetSelectAll(),
    getFolderSelection: () => runtimeSelection()?.paths
      .filter((item) => item.kind === 'dir')
      .map(({ path }) => ({ path }))
      ?? getFolderSelectionList().map((p) => ({ path: p })),
    getPathSelection: () => runtimeSelection()?.paths.map((item) => ({ ...item }))
      ?? getPathSelectionList(),
    deleteFolders: (folders) => {
      // Last-line guard: never confirm-delete paths while a text field owns focus
      // (global Delete/Backspace can still race past isTypingTarget in edge cases).
      if (isTextFieldFocused()) return;
      void (async () => {
        for (const f of folders) {
          const ok = await opts.confirmDeleteFolder(f.path);
          if (!ok) return;
          gateway.dispatch({ kind: 'deleteDirectory', path: f.path } as never, 'human');
        }
      })();
    },
    deletePathItems: (items) => {
      if (isTextFieldFocused()) return;
      const dirs = items.filter((i) => i.kind === 'dir');
      const files = items.filter((i) => i.kind === 'file');
      void (async () => {
        for (const d of dirs) {
          const ok = await opts.confirmDeleteFolder(d.path);
          if (!ok) return;
          gateway.dispatch({ kind: 'deleteDirectory', path: d.path } as never, 'human');
        }
        if (files.length > 0) {
          const names = files.map((f) => f.path).join(', ');
          const ok = await opts.confirmDeleteFolder(names);
          if (!ok) return;
          for (const f of files) {
            gateway.dispatch({ kind: 'deleteSourceFile', path: f.path, requestId: crypto.randomUUID() } as never, 'human');
          }
        }
      })();
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
