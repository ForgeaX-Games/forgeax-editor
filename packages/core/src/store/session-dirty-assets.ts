// session-dirty-assets — session-level "assets modified since last save
// checkpoint" set, the data source for the UE-style "Save Content" dialog.
//
// Asset edits are fire-and-forget (pack writes complete asynchronously and
// land on disk immediately — see session/material-ops.ts, session/pack-ops.ts).
// There is no in-memory staging and no per-asset dirty flag on the persistence
// context. To populate a "what changed this session" review list, this module
// intercepts asset-mutating Gateway ops at dispatch-apply time and records
// `{ guid, packPath?, kind?, name? }` per edited asset.
//
// The set is a review checkpoint, not a write queue: "Save Selected" clears
// the checked rows (assets are already on disk) and dispatches saveDocToDisk
// for the scene row. The whole set clears on a successful scene switch (a new
// scene is a new authoring context).
//
// R3: the top-level `gateway.subscribe(...)` is an EVAL-TIME side effect and MUST
// stay top-level (mirrors scene-persistence.ts dirty subscription) or tracking
// breaks.
import { useSyncExternalStore } from 'react';
import { gateway } from './gateway';
import type { BuiltinEditorOp, EditorOp } from '../types';

export interface SessionDirtyAsset {
  readonly guid: string;
  readonly packPath?: string;
  readonly kind?: string;
  readonly name?: string;
  readonly ts: number;
}

const dirtyAssets = new Map<string, SessionDirtyAsset>();
const listeners = new Set<() => void>();
// Cached snapshot for useSyncExternalStore: must return a STABLE reference while
// the map is unchanged, or the hook loops (Maximum update depth exceeded).
// Invalidated (set to null) on every mutation; rebuilt lazily by the getter.
let cachedSnapshot: readonly SessionDirtyAsset[] | null = null;

function emit(): void {
  cachedSnapshot = null;
  for (const listener of listeners) listener();
}

function record(asset: SessionDirtyAsset): void {
  dirtyAssets.set(asset.guid, asset);
  emit();
}

function remove(guid: string): void {
  if (dirtyAssets.delete(guid)) emit();
}

/** Narrow open `EditorOp` to a builtin variant. The open-union tail
 *  (`{ kind: string; [key: string]: unknown }`) otherwise leaves fields as
 *  `unknown` after `switch (op.kind)`. */
function asBuiltin<K extends BuiltinEditorOp['kind']>(
  op: EditorOp,
  kind: K,
): Extract<BuiltinEditorOp, { kind: K }> | null {
  return op.kind === kind ? (op as Extract<BuiltinEditorOp, { kind: K }>) : null;
}

/** Extract an asset identity from a known asset-mutating op, or null if the op
 *  does not mutate a tracked asset. */
function assetMutationOfOp(op: EditorOp): { readonly guid: string; readonly packPath?: string; readonly kind?: string; readonly name?: string } | null {
  switch (op.kind) {
    case 'createAsset': {
      const o = asBuiltin(op, 'createAsset');
      return o === null ? null : { guid: o.guid, packPath: o.packPath, kind: o.assetKind, name: o.name };
    }
    case 'createMaterial': {
      const o = asBuiltin(op, 'createMaterial');
      return o === null ? null : { guid: o.guid, packPath: o.packPath, kind: 'material', name: o.name };
    }
    case 'writeUi': {
      const o = asBuiltin(op, 'writeUi');
      return o === null ? null : { guid: o.guid, packPath: o.packPath, kind: 'ui', name: o.name };
    }
    case 'renameAsset': {
      const o = asBuiltin(op, 'renameAsset');
      return o === null ? null : { guid: o.guid, packPath: o.packPath, name: o.newName };
    }
    case 'duplicateAsset': {
      const o = asBuiltin(op, 'duplicateAsset');
      return o === null ? null : { guid: o.guid, packPath: o.packPath };
    }
    case 'updateMaterialParams': {
      const o = asBuiltin(op, 'updateMaterialParams');
      return o === null ? null : { guid: o.guid, packPath: o.packPath };
    }
    case 'saveAssetSourceOverride': {
      const o = asBuiltin(op, 'saveAssetSourceOverride');
      return o === null ? null : { guid: o.guid };
    }
    case 'restoreAsset': {
      const o = asBuiltin(op, 'restoreAsset');
      return o === null ? null : { guid: o.guid, packPath: o._resolvedPackPath };
    }
    case 'restoreWrittenAsset': {
      const o = asBuiltin(op, 'restoreWrittenAsset');
      return o === null ? null : { guid: o.guid, packPath: o.packPath };
    }
    case 'destroyAsset':
      // Destroyed assets are gone — drop them from the review list.
      return null;
    default:
      return null;
  }
}

gateway.subscribe((_doc, lastCommand) => {
  if (lastCommand === null) return;
  if (lastCommand.kind === 'destroyAsset') {
    const destroyed = asBuiltin(lastCommand, 'destroyAsset');
    if (destroyed !== null) remove(destroyed.guid);
    return;
  }
  const mutation = assetMutationOfOp(lastCommand);
  if (mutation === null) return;
  record({
    guid: mutation.guid,
    packPath: mutation.packPath,
    kind: mutation.kind,
    name: mutation.name,
    ts: Date.now(),
  });
});

// A successful scene switch starts a new authoring context — drop the stale
// per-asset review set so the next "Save Content" dialog only lists assets
// edited in the new scene.
gateway.subscribeOperationRuns((run) => {
  if (run.operationId === 'switchSceneFile' && run.status === 'succeeded') {
    clearAllSessionDirtyAssets();
  }
});

/** Read the current session dirty-asset set (insertion-ordered). Returns a
 *  stable reference across calls until the set changes. */
export function getSessionDirtyAssets(): readonly SessionDirtyAsset[] {
  if (cachedSnapshot === null) {
    cachedSnapshot = Array.from(dirtyAssets.values());
  }
  return cachedSnapshot;
}

/** Subscribe to session dirty-asset set changes. */
export function subscribeSessionDirtyAssets(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Clear the listed guids from the session dirty set (called after the user
 *  acknowledges them in the "Save Content" dialog). */
export function clearSessionDirtyAssets(guids: readonly string[]): void {
  if (guids.length === 0) return;
  let changed = false;
  for (const guid of guids) {
    if (dirtyAssets.delete(guid)) changed = true;
  }
  if (changed) emit();
}

/** Clear the entire session dirty set (e.g. on scene switch). */
export function clearAllSessionDirtyAssets(): void {
  if (dirtyAssets.size === 0) return;
  dirtyAssets.clear();
  emit();
}

/** React hook returning the live session dirty-asset set. */
export function useSessionDirtyAssets(): readonly SessionDirtyAsset[] {
  return useSyncExternalStore(
    subscribeSessionDirtyAssets,
    getSessionDirtyAssets,
    getSessionDirtyAssets,
  );
}
