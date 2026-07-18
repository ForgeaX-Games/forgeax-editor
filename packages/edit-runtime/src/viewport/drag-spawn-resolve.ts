// GUID -> mesh-handle bridge for Content Browser drag-spawn (feat-20260705 M3).
//
// requirements AC-10/AC-11 · plan-strategy §D-2/D-3/D-4 · research Finding 4
//
// The Content Browser mesh branch (core/assets/drag-asset-spawn.ts, w10) spawns a
// mesh entity with MeshFilter.assetHandle = 0 (sentinel) plus a command-level
// EditorPendingMeshAsset{guid} marker. The marker is a schema-outsider: it never
// reaches the world (spawnComponentData drops unregistered component names,
// plan-strategy §D-2) — it lives only inside the spawnEntity command.
//
// This module subscribes to the EditGateway and, for each spawnEntity command that
// carries the marker, resolves the real asset GUID to a mesh handle and patches
// MeshFilter.assetHandle over the bus:
//   AssetGuid.parse(guid) -> renderer.assets.loadByGuid -> world.allocSharedRef(
//   'MeshAsset', payload) -> bus.dispatch(setComponent MeshFilter{assetHandle}, 'ai')
//
// WHY over the bus and not world.set directly (plan-strategy §D-4): the EditGateway
// is the single authoritative mutable path — the setComponent goes through the
// ledger (AI-origin audit) and fires subscribers (viewport repaint). A raw
// world.set would mutate behind the ledger's back and skip the repaint.
//
// WHY round-trip holds (research Finding 4e): the handle is minted from
// loadByGuid -> allocSharedRef, so its payload sits in the registry catalog /
// origin index; on save, engine writeback (_guidForAsset) reverses handle -> GUID,
// so reopen + Play re-resolve the real mesh. A handle whose payload is NOT indexed
// would fail writeback loudly (SceneCollectAssetGuidUnresolvedError) — never a
// silent empty node.
//
// Failure discipline (charter proposition 4, plan-strategy §S-3): a bad GUID or a
// load miss records the GUID in `failed` and emits ONE structured console.error;
// subsequent redo replays of the same GUID short-circuit before re-loading — no
// retry storm. Resolved GUIDs are cached so a redo (or a second entity sharing the
// mesh) re-patches from cache without a second loadByGuid.

import { AssetGuid } from '@forgeax/engine-pack/guid';
import { EditGateway, type EditorOp, type EngineFacade } from '@forgeax/editor-core';

/** Loose renderer handle — the renderer type evolves independently, so we
 *  mirror host-boot's `as never` discipline with a narrow structural shape. */
type RendererLike = {
  assets: {
    loadByGuid(guid: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code?: string } }>;
  };
};

/** Pull the pending-mesh marker guid from a spawnEntity command, or null. */
function pendingMeshGuid(cmd: EditorOp | null): string | null {
  if (cmd === null || cmd.kind !== 'spawnEntity') return null;
  // EditorOp's open `{ kind: string }` tail keeps `kind === 'spawnEntity'` from
  // discriminating the builtin variant, so recover its `components` bag explicitly.
  const components = (cmd as { components?: Record<string, unknown> }).components;
  const marker = components?.EditorPendingMeshAsset as { guid?: unknown } | undefined;
  const guid = marker?.guid;
  return typeof guid === 'string' && guid.length > 0 ? guid : null;
}

/** Pull the pending-material marker GUID list from a spawnEntity command, or null.
 *  One entry per submesh in submesh order; `''` marks a primitive with no source
 *  glTF material (feat-20260708 M1, plan-strategy D-2). */
function pendingMaterialGuids(cmd: EditorOp | null): string[] | null {
  if (cmd === null || cmd.kind !== 'spawnEntity') return null;
  const components = (cmd as { components?: Record<string, unknown> }).components;
  const marker = components?.EditorPendingMeshMaterials as { guids?: unknown } | undefined;
  const guids = marker?.guids;
  return Array.isArray(guids) && guids.length > 0 && guids.every((g) => typeof g === 'string')
    ? (guids as string[])
    : null;
}

/** Pull the pending-texture marker guid from a spawnEntity command, or null. */
function pendingTextureGuid(cmd: EditorOp | null): string | null {
  if (cmd === null || cmd.kind !== 'spawnEntity') return null;
  const components = (cmd as { components?: Record<string, unknown> }).components;
  const marker = components?.EditorPendingTextureAsset as { guid?: unknown } | undefined;
  const guid = marker?.guid;
  return typeof guid === 'string' && guid.length > 0 ? guid : null;
}

/**
 * Subscribe the drag-spawn resolver to the EditGateway. Two INDEPENDENT branches
 * ride the same spawnEntity command:
 *   - the MESH branch resolves EditorPendingMeshAsset -> MeshFilter.assetHandle;
 *   - the MATERIAL branch resolves EditorPendingMeshMaterials -> MeshRenderer.materials[].
 * Both are idempotent per GUID: failed GUIDs are never retried, resolved GUIDs are
 * re-patched from cache (redo replay / a second entity sharing the asset).
 */
export function installDragSpawnMeshResolver(bus: EditGateway, engine: EngineFacade, renderer: RendererLike): void {
  // M3 migration bridge (t16→t20): the injected proxy is `engine` (EngineFacade).
  // t16 swaps the signature; t20 rewrites the body to call engine.allocSharedRef
  // t20 (S4 / AC-05): the mesh handle is minted through the injected EngineFacade
  // (ctx.engine proxy). allocSharedRef is chrome handle-casting, not a document op
  // — the resulting handle rides the setComponent bus dispatch below (which DOES
  // go through the ledger). The facade returns an opaque handle; narrow to the u32
  // the MeshFilter.assetHandle patch expects. §5.6 lint-unique-mutator: the ONLY
  // world write here is engine.allocSharedRef (facade method) — never raw world.*.
  const failed = new Set<string>();
  const resolved = new Map<string, number>();
  const failedMat = new Set<string>();
  const resolvedMat = new Map<string, number>();

  const patchMesh = (entity: number, assetHandle: number): void => {
    bus.dispatch({ kind: 'setComponent', entity, component: 'MeshFilter', patch: { assetHandle } }, 'ai');
  };

  // ── MESH branch (feat-20260705 M3, behaviour unchanged) ──────────────────────
  const resolveMesh = (entity: number, guid: string): void => {
    // Retry-storm guard: a GUID that already failed is never re-attempted.
    if (failed.has(guid)) return;
    // Cache hit (redo replay / second entity sharing the mesh): re-patch, no reload.
    const cached = resolved.get(guid);
    if (cached !== undefined) { patchMesh(entity, cached); return; }

    const parsed = AssetGuid.parse(guid);
    if (!parsed.ok) {
      failed.add(guid);
      console.error('[drag-spawn-resolve]', { guid, code: 'bad-guid', hint: 'AssetGuid.parse failed' });
      return;
    }

    void (async () => {
      const res = await renderer.assets.loadByGuid(parsed.value);
      if (!res.ok || res.value === undefined) {
        failed.add(guid);
        console.error('[drag-spawn-resolve]', { guid, code: 'load-miss', hint: res.error?.code ?? 'loadByGuid returned no value' });
        return;
      }
      const handle = engine.allocSharedRef('MeshAsset', res.value) as number;
      resolved.set(guid, handle);
      patchMesh(entity, handle);
    })();
  };

  // Resolve ONE material GUID to a handle (cache + failed-guard + structured error),
  // or undefined if unresolvable. Mirrors the mesh branch's discipline (D-5).
  const resolveOneMaterial = async (guid: string): Promise<number | undefined> => {
    const cached = resolvedMat.get(guid);
    if (cached !== undefined) return cached;
    if (failedMat.has(guid)) return undefined; // already failed: no retry, no dup error
    const parsed = AssetGuid.parse(guid);
    if (!parsed.ok) {
      failedMat.add(guid);
      console.error('[drag-spawn-resolve:material]', { guid, code: 'bad-guid', hint: 'AssetGuid.parse failed' });
      return undefined;
    }
    const res = await renderer.assets.loadByGuid(parsed.value);
    if (!res.ok || res.value === undefined) {
      failedMat.add(guid);
      console.error('[drag-spawn-resolve:material]', { guid, code: 'load-miss', hint: res.error?.code ?? 'loadByGuid returned no value' });
      return undefined;
    }
    const handle = engine.allocSharedRef('MaterialAsset', res.value) as number;
    resolvedMat.set(guid, handle);
    return handle;
  };

  // ── MATERIAL branch (feat-20260708 M1, plan-strategy D-2/D-3/D-5) ─────────────
  const resolveMaterials = async (entity: number, guids: string[]): Promise<void> => {
    // Resolve each non-empty GUID in submesh order; the first that resolves is the
    // firstMatHandle used to fill '' slots (and load misses) so the emitted
    // materials[].length always equals guids.length — the same count-alignment the
    // engine bridge enforces (bridge.ts:539-562), else the engine fail-fast
    // `mesh-renderer-material-count-mismatch` would skip the entity (D-3).
    const handleByGuid = new Map<string, number>();
    let firstMatHandle: number | undefined;
    for (const g of guids) {
      if (g === '') continue;
      const handle = await resolveOneMaterial(g);
      if (handle === undefined) continue;
      handleByGuid.set(g, handle);
      if (firstMatHandle === undefined) firstMatHandle = handle;
    }
    // Nothing resolved (all '' or all failed): keep the engine's default-material
    // MeshRenderer (graceful degradation, R-3) — a length-0 patch would be a no-op
    // and a partial one cannot satisfy count alignment.
    if (firstMatHandle === undefined) return;

    const materials = guids.map((g) => (g !== '' ? (handleByGuid.get(g) ?? firstMatHandle) : firstMatHandle));
    bus.dispatch({ kind: 'setComponent', entity, component: 'MeshRenderer', patch: { materials } }, 'ai');
  };

  bus.subscribe((_doc, lastCommand) => {
    if (lastCommand === null || lastCommand.kind !== 'spawnEntity') return;
    // This is the BUS path — it sees only lastCommand, not the DispatchResult, so
    // it reads the handle off the applier-filled cmd._id (still written in place;
    // result.created is the return-value channel for direct dispatch callers).
    const entity = (lastCommand as Extract<EditorOp, { kind: 'spawnEntity' }>)._id;
    if (typeof entity !== 'number') return;

    const meshGuid = pendingMeshGuid(lastCommand);
    if (meshGuid !== null) resolveMesh(entity, meshGuid);

    const matGuids = pendingMaterialGuids(lastCommand);
    if (matGuids !== null) void resolveMaterials(entity, matGuids);

    // ── TEXTURE branch: createMaterial + bindAssetRef (reuses engine refs chain) ──
    const texGuid = pendingTextureGuid(lastCommand);
    if (texGuid !== null) void resolveTexture(bus, entity, texGuid);
  });
}

/**
 * Resolve a texture dragged into the viewport: create a new MaterialAsset with the
 * texture bound as baseColorTexture, then bind it to the spawned entity's MeshRenderer.
 * Mirrors the mesh resolver pattern — every step goes through bus.dispatch (gateway).
 * `createMaterial` is a document op (undoable, writes to pack); `bindAssetRef` is a
 * session op (loadByGuid → allocSharedRef → setComponent).
 */
async function resolveTexture(bus: EditGateway, entity: number, textureGuid: string): Promise<void> {
  const materialGuid = crypto.randomUUID();
  const r1 = bus.dispatch({
    kind: 'createMaterial',
    guid: materialGuid,
    name: `mat_${textureGuid.slice(0, 8)}`,
    baseColor: [1, 1, 1, 1],
    baseColorTexture: textureGuid,
  }, 'ai');
  if (!r1.ok) {
    console.error('[drag-spawn-resolve:texture] createMaterial failed', r1);
    return;
  }
  bus.dispatch({
    kind: 'bindAssetRef',
    entity,
    component: 'MeshRenderer',
    field: 'materials',
    assetType: 'MaterialAsset',
    guids: [materialGuid],
  }, 'ai');
}
