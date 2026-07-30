// session/material-ops — updateMaterialParams document applier.
//
// DOCUMENT-domain op (undoable, enters ledger). Shallow-merges `paramPatch` into
// the existing MaterialAsset's `paramValues`, writes the updated entry through
// ctx.assetIO, then invalidates the registry cache for hot viewport reload.
//
// Gateway fills _oldPatch / _oldRefs / _oldEntry synchronously from assetCatalog
// before the applier runs — same pattern as destroyEntity._asset / duplicateEntity._asset.
//
// Anchors:
//   dev-plan §7.2: applier design (gateway-fill, fire-and-forget IO)
//   dev-plan §10.7: invalidateAsset hot-refresh after write
//   north-star §9: writes through ctx.assetIO (sole asset write gate)

import { registerApplier, type ApplierFn } from '../io/appliers';
import { broadcastAssetsChanged } from '../store/assets-changed';
import { broadcastAssetsError } from '../store/assets-error-bus';
import type { DocApplierCtx } from './document';
import type { ApplyResult, EditorOp } from '../types';

interface UpdateMaterialParamsOp {
  kind: 'updateMaterialParams';
  packPath: string;
  guid: string;
  paramPatch: Record<string, unknown>;
  textureGuids?: Record<string, string | null>;
  _oldPatch?: Record<string, unknown>;
  _oldRefs?: string[];
  _oldEntry?: unknown;
}

interface PackAssetEntry {
  guid: string;
  kind: string;
  name?: string;
  payload: Record<string, unknown>;
  refs: string[];
}

function _ioFailHint(op: string, path: string, e: unknown): string {
  return `${op}("${path}") background IO failed: ${e instanceof Error ? e.message : String(e)}`;
}

/** Encode texture GUIDs into the refs array and update paramValues indices.
 *  For each entry in textureGuids:
 *  - non-null GUID: ensure it exists in refs[], write its index into nextParams[key]
 *  - null: delete the key from nextParams (clear the texture binding) */
function encodeTextureRefs(
  currentRefs: string[],
  textureGuids: Record<string, string | null>,
  nextParams: Record<string, unknown>,
): { refs: string[] } {
  const refs = [...currentRefs];
  for (const [key, guid] of Object.entries(textureGuids)) {
    if (guid === null) {
      delete nextParams[key];
    } else {
      let idx = refs.indexOf(guid);
      if (idx === -1) { refs.push(guid); idx = refs.length - 1; }
      nextParams[key] = idx;
    }
  }
  return { refs };
}

/** Build inverse textureGuids from old refs + old paramValues. */
function invertTextureGuids(
  oldRefs: string[],
  textureGuids: Record<string, string | null>,
  oldParamValues: Record<string, unknown>,
): Record<string, string | null> {
  const inv: Record<string, string | null> = {};
  for (const key of Object.keys(textureGuids)) {
    const oldVal = oldParamValues[key];
    if (typeof oldVal === 'number' && oldRefs[oldVal]) {
      inv[key] = oldRefs[oldVal]!;
    } else {
      inv[key] = null;
    }
  }
  return inv;
}

export function applyUpdateMaterialParams(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  const cmd = _cmd as unknown as UpdateMaterialParamsOp;
  const { packPath, guid, paramPatch, textureGuids, _oldPatch, _oldRefs, _oldEntry } = cmd;

  if (typeof packPath !== 'string' || packPath.length === 0)
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'updateMaterialParams: packPath required' } };
  if (typeof guid !== 'string' || guid.length === 0)
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'updateMaterialParams: guid required' } };
  if (!paramPatch || typeof paramPatch !== 'object')
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'updateMaterialParams: paramPatch required' } };
  if (!_oldPatch)
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'updateMaterialParams: _oldPatch missing (gateway should fill)' } };
  if (!_oldEntry)
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'updateMaterialParams: _oldEntry missing (gateway should fill)' } };

  const beforePayload = _oldPatch as Record<string, unknown>;
  const nextParams = { ...beforePayload };
  for (const [k, v] of Object.entries(paramPatch)) {
    if (v === undefined) delete nextParams[k];
    else nextParams[k] = v;
  }

  const beforeRefs = _oldRefs ? [..._oldRefs] : [];
  let nextRefs = beforeRefs;
  if (textureGuids) {
    const res = encodeTextureRefs(beforeRefs, textureGuids, nextParams);
    nextRefs = res.refs;
  }

  const currentEntry = _oldEntry as PackAssetEntry;
  const nextEntry: PackAssetEntry = {
    ...currentEntry,
    payload: { ...(currentEntry.payload as Record<string, unknown>), paramValues: nextParams },
    refs: nextRefs,
  };

  // Build the IN-MEMORY paramValues for the live catalogue/sharedRef payload.
  // On disk texture fields are refs[] indices (nextParams, via encodeTextureRefs);
  // the loaded/live form uses GUID strings (materialLoader index→GUID), so mirror
  // that here from textureGuids. Scalars (baseColor/metallic/roughness) are
  // identical in both forms.
  const liveParams: Record<string, unknown> = { ...nextParams };
  if (textureGuids) {
    for (const [key, texGuid] of Object.entries(textureGuids)) {
      if (texGuid === null) delete liveParams[key];
      else liveParams[key] = texGuid;
    }
  }

  const engine = ctx.engine;
  void ctx.assetIO.writePackEntry(packPath, nextEntry as never)
    .then((written) => {
      // writePackEntry resolves false (not throw) when the pack read/write
      // failed (e.g. the file backend rejected the path with HTTP 400) —
      // without this guard the op looked successful while nothing hit disk.
      if (!written) {
        broadcastAssetsError({ op: 'updateMaterialParams', path: packPath, hint: _ioFailHint('updateMaterialParams', packPath, new Error('writePackEntry returned false (pack read/write failed)')) });
        return;
      }
      // Hot-reload: mutate the live material payload in place so the viewport
      // reflects the change on the next frame WITHOUT a scene reload, and so the
      // save path (appendInlineAssets → reg.lookup) serialises the new values
      // instead of clobbering them from the load-time snapshot. patchLiveMaterialParams
      // also evicts the stale pack-body cache so a save-triggered refresh re-reads the
      // fresh disk bytes. Replaces the old invalidateAsset(guid), which dropped the
      // catalogue entry and left the sharedRef stale (viewport unchanged).
      engine.patchLiveMaterialParams(guid, liveParams);
      broadcastAssetsChanged();
    })
    .catch((e) => broadcastAssetsError({ op: 'updateMaterialParams', path: packPath, hint: _ioFailHint('updateMaterialParams', packPath, e) }));

  const inversePatch: Record<string, unknown> = {};
  for (const k of Object.keys(paramPatch)) inversePatch[k] = beforePayload[k];

  return {
    ok: true,
    inverse: {
      kind: 'updateMaterialParams',
      packPath,
      guid,
      paramPatch: inversePatch,
      textureGuids: textureGuids ? invertTextureGuids(beforeRefs, textureGuids, beforePayload) : undefined,
    } as unknown as EditorOp,
    created: [],
  };
}

registerApplier('document', 'updateMaterialParams', applyUpdateMaterialParams as unknown as ApplierFn);
