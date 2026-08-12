// session/material-instance-ops — Material Instance document appliers (M1/A3).
//
// DOCUMENT-domain ops (undoable, enter ledger). Writes go through ctx.assetIO.
// Hot-patch of a live MaterialAsset is intentionally NOT done here: MI payloads
// are not `kind:'material'`, so patchLiveMaterialParams would no-op. Preview
// wiring (C4) maintains a resolved runtime material GUID separately.
//
// Anchors: .forgeax-harness/docs/2026-08-05-material-instance-editor-tech-plan.md §A3

import { broadcastAssetsChanged } from '../store/assets-changed';
import { broadcastAssetsError } from '../store/assets-error-bus';
import { scheduleAuthoredAssetWrite } from './authored-asset-write';
import { resolveGamePath } from '../util/path-resolver';
import {
  MATERIAL_INSTANCE_KIND,
  createDefaultMaterialInstancePayload,
  encodeMaterialInstancePackRefs,
  isGuid,
  isMaterialInstancePayload,
  type MaterialInstanceLightmass,
  type MaterialInstanceOverride,
  type MaterialInstancePayload,
} from '../assets/material-instance-schema';
import { wouldCreateParentCycle, type MaterialCatalogLookup } from '../assets/material-instance-resolve';
import type { ApplyResult, EditorOp } from '../types';

/** Narrow write surface used by MI appliers (avoids importing session/document). */
interface MiApplierCtx {
  readonly assetIO: {
    createAssetInPack(args: {
      packPath: string;
      asset: {
        guid: string;
        kind: string;
        name: string;
        payload: unknown;
        refs?: string[];
      };
    }): Promise<{ ok: true } | { ok: false; reason: string; hint: string }>;
    writePackEntry(packPath: string, entry: unknown): Promise<boolean>;
  };
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

function asMiPayload(entry: PackAssetEntry): MaterialInstancePayload | undefined {
  return isMaterialInstancePayload(entry.payload) ? entry.payload : undefined;
}

function writeMiEntry(
  ctx: MiApplierCtx,
  packPath: string,
  entry: PackAssetEntry,
  opName: string,
): void {
  void ctx.assetIO.writePackEntry(packPath, entry as never)
    .then((written) => {
      if (!written) {
        broadcastAssetsError({
          op: opName,
          path: packPath,
          hint: _ioFailHint(opName, packPath, new Error('writePackEntry returned false')),
        });
        return;
      }
      broadcastAssetsChanged();
    })
    .catch((e) => broadcastAssetsError({ op: opName, path: packPath, hint: _ioFailHint(opName, packPath, e) }));
}

/** Build a catalog lookup from a gateway-filled _oldEntry snapshot + optional parent chain stubs. */
export function catalogLookupFromEntries(
  entries: readonly PackAssetEntry[],
): MaterialCatalogLookup {
  const map = new Map<string, PackAssetEntry>();
  for (const entry of entries) map.set(entry.guid.toLowerCase(), entry);
  return (guid) => {
    const hit = map.get(guid.toLowerCase());
    if (!hit) return undefined;
    return { guid: hit.guid, kind: hit.kind, payload: hit.payload };
  };
}

// ── createMaterialInstance ───────────────────────────────────────────────────

export function applyCreateMaterialInstance(ctx: MiApplierCtx, cmd: EditorOp): ApplyResult {
  const {
    guid, name, parentGuid, overrides, physMaterial, lightmass, packPath,
  } = cmd as {
    guid: string;
    name: string;
    parentGuid: string;
    overrides?: Record<string, MaterialInstanceOverride>;
    physMaterial?: string;
    lightmass?: Partial<MaterialInstanceLightmass>;
    packPath?: string;
  };

  if (!isGuid(guid)) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'createMaterialInstance requires a non-empty RFC 4122 `guid`' } };
  }
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'createMaterialInstance requires a non-empty `name`' } };
  }
  if (!isGuid(parentGuid)) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'createMaterialInstance requires a valid `parentGuid`' } };
  }
  if (physMaterial !== undefined && !isGuid(physMaterial)) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'createMaterialInstance `physMaterial` must be a valid GUID when present' } };
  }

  let payload: MaterialInstancePayload;
  try {
    payload = createDefaultMaterialInstancePayload(parentGuid, { overrides, physMaterial, lightmass });
  } catch (e) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: e instanceof Error ? e.message : String(e) } };
  }

  const encoded = encodeMaterialInstancePackRefs(payload);
  if (!encoded.ok) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: encoded.error.hint } };
  }

  let targetPack: string;
  try {
    targetPack = resolveGamePath(
      typeof packPath === 'string' && packPath.length > 0
        ? packPath
        : 'assets/materials.pack.json',
    );
  } catch {
    return {
      ok: false,
      error: {
        code: 'INVALID_ARGS',
        hint: 'createMaterialInstance requires an active game path resolver; select a game before authoring',
      },
    };
  }

  // Same commit contract as createMaterial: the write is awaited to a
  // DIAGNOSABLE result, then the host's pack-index barrier runs BEFORE
  // assetsChanged fires. Broadcasting the moment the bytes land races the
  // watcher rebuild and the Content Browser refreshes against a pack-index
  // that predates the write — the "created but nowhere in the asset tree"
  // report. awaitAuthoredMaterialReady(guid) resolves the same completion.
  return scheduleAuthoredAssetWrite(ctx, targetPack, {
    guid,
    kind: MATERIAL_INSTANCE_KIND,
    name,
    payload: encoded.payload as unknown as Record<string, unknown>,
    refs: encoded.refs,
  });
}

// ── saveMaterialInstance ─────────────────────────────────────────────────────

export function applySaveMaterialInstance(ctx: MiApplierCtx, _cmd: EditorOp): ApplyResult {
  const cmd = _cmd as {
    kind: 'saveMaterialInstance';
    packPath: string;
    guid: string;
    payload: MaterialInstancePayload;
    _oldEntry?: PackAssetEntry;
  };

  if (typeof cmd.packPath !== 'string' || cmd.packPath.length === 0) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'saveMaterialInstance: packPath required' } };
  }
  if (!isGuid(cmd.guid)) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'saveMaterialInstance: guid required' } };
  }
  if (!isMaterialInstancePayload(cmd.payload)) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'saveMaterialInstance: payload must be a material-instance' } };
  }
  if (!cmd._oldEntry) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'saveMaterialInstance: _oldEntry missing (gateway should fill)' } };
  }

  const encoded = encodeMaterialInstancePackRefs(cmd.payload, cmd._oldEntry.refs);
  if (!encoded.ok) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: encoded.error.hint } };
  }

  const nextEntry: PackAssetEntry = {
    ...cmd._oldEntry,
    kind: MATERIAL_INSTANCE_KIND,
    payload: encoded.payload as unknown as Record<string, unknown>,
    refs: encoded.refs,
  };
  writeMiEntry(ctx, cmd.packPath, nextEntry, 'saveMaterialInstance');

  return {
    ok: true,
    inverse: {
      kind: 'saveMaterialInstance',
      packPath: cmd.packPath,
      guid: cmd.guid,
      payload: cmd._oldEntry.payload,
      _oldEntry: nextEntry,
    } as unknown as EditorOp,
    created: [],
  };
}

// ── setMaterialInstanceParent ────────────────────────────────────────────────

export function applySetMaterialInstanceParent(ctx: MiApplierCtx, _cmd: EditorOp): ApplyResult {
  const cmd = _cmd as {
    kind: 'setMaterialInstanceParent';
    packPath: string;
    guid: string;
    parentGuid: string;
    _oldEntry?: PackAssetEntry;
    /** Optional extra catalog entries for cycle detection (parent chain). */
    _catalogEntries?: PackAssetEntry[];
  };

  if (typeof cmd.packPath !== 'string' || cmd.packPath.length === 0) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'setMaterialInstanceParent: packPath required' } };
  }
  if (!isGuid(cmd.guid) || !isGuid(cmd.parentGuid)) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'setMaterialInstanceParent: guid and parentGuid required' } };
  }
  if (!cmd._oldEntry) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'setMaterialInstanceParent: _oldEntry missing (gateway should fill)' } };
  }

  const current = asMiPayload(cmd._oldEntry);
  if (!current) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'setMaterialInstanceParent: target is not a material-instance' } };
  }

  const lookup = catalogLookupFromEntries([
    cmd._oldEntry,
    ...(cmd._catalogEntries ?? []),
  ]);
  if (wouldCreateParentCycle(cmd.guid, cmd.parentGuid, lookup)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_ARGS',
        hint: 'setMaterialInstanceParent: parentGuid would create a parent cycle',
      },
    };
  }

  const nextPayload: MaterialInstancePayload = { ...current, parent: cmd.parentGuid };
  const encoded = encodeMaterialInstancePackRefs(nextPayload, cmd._oldEntry.refs);
  if (!encoded.ok) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: encoded.error.hint } };
  }

  const nextEntry: PackAssetEntry = {
    ...cmd._oldEntry,
    payload: encoded.payload as unknown as Record<string, unknown>,
    refs: encoded.refs,
  };
  writeMiEntry(ctx, cmd.packPath, nextEntry, 'setMaterialInstanceParent');

  return {
    ok: true,
    inverse: {
      kind: 'setMaterialInstanceParent',
      packPath: cmd.packPath,
      guid: cmd.guid,
      parentGuid: current.parent,
      _oldEntry: nextEntry,
    } as unknown as EditorOp,
    created: [],
  };
}

// ── setMaterialInstanceOverride ──────────────────────────────────────────────

export function applySetMaterialInstanceOverride(ctx: MiApplierCtx, _cmd: EditorOp): ApplyResult {
  const cmd = _cmd as {
    kind: 'setMaterialInstanceOverride';
    packPath: string;
    guid: string;
    paramKey: string;
    enabled: boolean;
    value?: unknown;
    bucket?: 'overrides' | 'propertyOverrides';
    _oldEntry?: PackAssetEntry;
  };

  if (typeof cmd.packPath !== 'string' || cmd.packPath.length === 0) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'setMaterialInstanceOverride: packPath required' } };
  }
  if (!isGuid(cmd.guid) || typeof cmd.paramKey !== 'string' || cmd.paramKey.length === 0) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'setMaterialInstanceOverride: guid and paramKey required' } };
  }
  if (typeof cmd.enabled !== 'boolean') {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'setMaterialInstanceOverride: enabled must be boolean' } };
  }
  if (!cmd._oldEntry) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'setMaterialInstanceOverride: _oldEntry missing (gateway should fill)' } };
  }

  const current = asMiPayload(cmd._oldEntry);
  if (!current) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'setMaterialInstanceOverride: target is not a material-instance' } };
  }

  const bucket = cmd.bucket === 'propertyOverrides' ? 'propertyOverrides' : 'overrides';
  const previousMap = { ...(current[bucket] ?? {}) };
  const previous = previousMap[cmd.paramKey];

  const nextMap = { ...previousMap };
  if (!cmd.enabled && cmd.value === undefined) {
    delete nextMap[cmd.paramKey];
  } else {
    nextMap[cmd.paramKey] = {
      enabled: cmd.enabled,
      ...(cmd.value !== undefined ? { value: cmd.value } : previous?.value !== undefined ? { value: previous.value } : {}),
    };
  }

  const nextPayload: MaterialInstancePayload = {
    ...current,
    [bucket]: nextMap,
  };
  const encoded = encodeMaterialInstancePackRefs(nextPayload, cmd._oldEntry.refs);
  if (!encoded.ok) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: encoded.error.hint } };
  }

  const nextEntry: PackAssetEntry = {
    ...cmd._oldEntry,
    payload: encoded.payload as unknown as Record<string, unknown>,
    refs: encoded.refs,
  };
  writeMiEntry(ctx, cmd.packPath, nextEntry, 'setMaterialInstanceOverride');

  return {
    ok: true,
    inverse: {
      kind: 'setMaterialInstanceOverride',
      packPath: cmd.packPath,
      guid: cmd.guid,
      paramKey: cmd.paramKey,
      enabled: previous?.enabled ?? false,
      value: previous?.value,
      bucket,
      _oldEntry: nextEntry,
    } as unknown as EditorOp,
    created: [],
  };
}

// ── setMaterialInstanceLightmass ─────────────────────────────────────────────

export function applySetMaterialInstanceLightmass(ctx: MiApplierCtx, _cmd: EditorOp): ApplyResult {
  const cmd = _cmd as {
    kind: 'setMaterialInstanceLightmass';
    packPath: string;
    guid: string;
    lightmassPatch: Partial<MaterialInstanceLightmass>;
    _oldEntry?: PackAssetEntry;
  };

  if (typeof cmd.packPath !== 'string' || cmd.packPath.length === 0) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'setMaterialInstanceLightmass: packPath required' } };
  }
  if (!isGuid(cmd.guid)) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'setMaterialInstanceLightmass: guid required' } };
  }
  if (!cmd.lightmassPatch || typeof cmd.lightmassPatch !== 'object') {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'setMaterialInstanceLightmass: lightmassPatch required' } };
  }
  if (!cmd._oldEntry) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'setMaterialInstanceLightmass: _oldEntry missing (gateway should fill)' } };
  }

  const current = asMiPayload(cmd._oldEntry);
  if (!current) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'setMaterialInstanceLightmass: target is not a material-instance' } };
  }

  const before = current.lightmass;
  const nextLightmass: MaterialInstanceLightmass = { ...before, ...cmd.lightmassPatch };
  const nextPayload: MaterialInstancePayload = { ...current, lightmass: nextLightmass };
  const encoded = encodeMaterialInstancePackRefs(nextPayload, cmd._oldEntry.refs);
  if (!encoded.ok) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: encoded.error.hint } };
  }

  const nextEntry: PackAssetEntry = {
    ...cmd._oldEntry,
    payload: encoded.payload as unknown as Record<string, unknown>,
    refs: encoded.refs,
  };
  writeMiEntry(ctx, cmd.packPath, nextEntry, 'setMaterialInstanceLightmass');

  const inversePatch: { -readonly [K in keyof MaterialInstanceLightmass]?: MaterialInstanceLightmass[K] } = {};
  for (const key of Object.keys(cmd.lightmassPatch) as Array<keyof MaterialInstanceLightmass>) {
    inversePatch[key] = before[key] as never;
  }

  return {
    ok: true,
    inverse: {
      kind: 'setMaterialInstanceLightmass',
      packPath: cmd.packPath,
      guid: cmd.guid,
      lightmassPatch: inversePatch,
      _oldEntry: nextEntry,
    } as unknown as EditorOp,
    created: [],
  };
}
