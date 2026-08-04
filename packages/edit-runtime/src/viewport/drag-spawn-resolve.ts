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
import { EditGateway, awaitPostAssetWriteCatalogSync, broadcastAssetsError, type EditorOp, type EngineFacade } from '@forgeax/editor-core';

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

/** Pull the pending-texture marker from a spawnEntity command, or null.
 *  The marker carries the texture guid plus the drag-ref display name so the
 *  resolver can mint a UE-style material name (M_<texture>). */
function pendingTextureMarker(cmd: EditorOp | null): { guid: string; name: string | null } | null {
  if (cmd === null || cmd.kind !== 'spawnEntity') return null;
  const components = (cmd as { components?: Record<string, unknown> }).components;
  const marker = components?.EditorPendingTextureAsset as { guid?: unknown; name?: unknown } | undefined;
  const guid = marker?.guid;
  if (typeof guid !== 'string' || guid.length === 0) return null;
  const name = typeof marker?.name === 'string' && marker.name.length > 0 ? marker.name : null;
  return { guid, name };
}

/** Pull the spawn-time Transform (array-TRS POD) from a spawnEntity command,
 *  or null when missing/malformed. The texture branch uses it as the baseline
 *  for the aspect-correct scale patch (and to preserve the authored x/z). */
function spawnTransform(cmd: EditorOp | null): { pos: [number, number, number]; scale: [number, number, number] } | null {
  if (cmd === null || cmd.kind !== 'spawnEntity') return null;
  const components = (cmd as { components?: Record<string, unknown> }).components;
  const t = components?.Transform as { pos?: unknown; scale?: unknown } | undefined;
  const pos = t?.pos;
  const scale = t?.scale;
  if (!Array.isArray(pos) || pos.length !== 3 || !pos.every((n) => typeof n === 'number')) return null;
  if (!Array.isArray(scale) || scale.length !== 3 || !scale.every((n) => typeof n === 'number')) return null;
  return { pos: pos as [number, number, number], scale: scale as [number, number, number] };
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
    const result = bus.dispatch({ kind: 'setComponent', entity, component: 'MeshFilter', patch: { assetHandle } }, 'ai');
    console.info(`[placement-diag] resolver.mesh.patch ${JSON.stringify({
      entity,
      assetHandle,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
    })}`);
  };

  // ── MESH branch (feat-20260705 M3, behaviour unchanged) ──────────────────────
  const resolveMesh = (entity: number, guid: string): void => {
    console.info(`[placement-diag] resolver.mesh.begin ${JSON.stringify({ entity, guid })}`);
    // Retry-storm guard: a GUID that already failed is never re-attempted.
    if (failed.has(guid)) {
      console.info(`[placement-diag] resolver.mesh.skipped ${JSON.stringify({ entity, guid, reason: 'previous-failure' })}`);
      return;
    }
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
      console.info(`[placement-diag] resolver.mesh.load ${JSON.stringify({
        entity,
        guid,
        ok: res.ok,
        errorCode: res.error?.code,
      })}`);
      if (!res.ok || res.value === undefined) {
        failed.add(guid);
        console.error('[drag-spawn-resolve]', { guid, code: 'load-miss', hint: res.error?.code ?? 'loadByGuid returned no value' });
        return;
      }
      const handle = engine.allocSharedRef('MeshAsset', res.value) as number;
      console.info(`[placement-diag] resolver.mesh.allocated ${JSON.stringify({ entity, guid, handle })}`);
      resolved.set(guid, handle);
      patchMesh(entity, handle);
    })();
  };

  // Resolve ONE material GUID to a handle (cache + failed-guard + structured error),
  // or undefined if unresolvable. Mirrors the mesh branch's discipline (D-5).
  const resolveOneMaterial = async (guid: string): Promise<number | undefined> => {
    console.info(`[placement-diag] resolver.material.begin ${JSON.stringify({ guid })}`);
    const cached = resolvedMat.get(guid);
    if (cached !== undefined) {
      console.info(`[placement-diag] resolver.material.cached ${JSON.stringify({ guid, handle: cached })}`);
      return cached;
    }
    if (failedMat.has(guid)) {
      console.info(`[placement-diag] resolver.material.skipped ${JSON.stringify({ guid, reason: 'previous-failure' })}`);
      return undefined; // already failed: no retry, no dup error
    }
    const parsed = AssetGuid.parse(guid);
    if (!parsed.ok) {
      failedMat.add(guid);
      console.error('[drag-spawn-resolve:material]', { guid, code: 'bad-guid', hint: 'AssetGuid.parse failed' });
      return undefined;
    }
    const res = await renderer.assets.loadByGuid(parsed.value);
    console.info(`[placement-diag] resolver.material.load ${JSON.stringify({
      guid,
      ok: res.ok,
      errorCode: res.error?.code,
    })}`);
    if (!res.ok || res.value === undefined) {
      failedMat.add(guid);
      console.error('[drag-spawn-resolve:material]', { guid, code: 'load-miss', hint: res.error?.code ?? 'loadByGuid returned no value' });
      return undefined;
    }
    const handle = engine.allocSharedRef('MaterialAsset', res.value) as number;
    console.info(`[placement-diag] resolver.material.allocated ${JSON.stringify({ guid, handle })}`);
    resolvedMat.set(guid, handle);
    return handle;
  };

  // ── MATERIAL branch (feat-20260708 M1, plan-strategy D-2/D-3/D-5) ─────────────
  const resolveMaterials = async (entity: number, guids: string[]): Promise<void> => {
    console.info(`[placement-diag] resolver.materials.begin ${JSON.stringify({ entity, guids })}`);
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
    if (firstMatHandle === undefined) {
      console.warn(`[placement-diag] resolver.materials.no-handle ${JSON.stringify({ entity, guids })}`);
      return;
    }

    const materials = guids.map((g) => (g !== '' ? (handleByGuid.get(g) ?? firstMatHandle) : firstMatHandle));
    const result = bus.dispatch({ kind: 'setComponent', entity, component: 'MeshRenderer', patch: { materials } }, 'ai');
    console.info(`[placement-diag] resolver.materials.patch ${JSON.stringify({
      entity,
      guids,
      handles: materials,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
    })}`);
  };

  bus.subscribe((_doc, lastCommand) => {
    if (lastCommand === null || lastCommand.kind !== 'spawnEntity') return;
    // This is the BUS path — it sees only lastCommand, not the DispatchResult, so
    // it reads the handle off the applier-filled cmd._id (still written in place;
    // result.created is the return-value channel for direct dispatch callers).
    const entity = (lastCommand as Extract<EditorOp, { kind: 'spawnEntity' }>)._id;
    if (typeof entity !== 'number') return;

    const meshGuid = pendingMeshGuid(lastCommand);
    const matGuids = pendingMaterialGuids(lastCommand);
    const texMarker = pendingTextureMarker(lastCommand);
    if (meshGuid !== null || matGuids !== null || texMarker !== null) {
      console.info(`[placement-diag] resolver.command ${JSON.stringify({
        entity,
        meshGuid,
        materialGuids: matGuids,
        textureGuid: texMarker?.guid ?? null,
      })}`);
    }
    if (meshGuid !== null) resolveMesh(entity, meshGuid);
    if (matGuids !== null) void resolveMaterials(entity, matGuids);

    // ── TEXTURE branch: createMaterial + bindAssetRef (reuses engine refs chain) ──
    if (texMarker !== null) void resolveTexture(bus, renderer, entity, texMarker.guid, texMarker.name, spawnTransform(lastCommand));
  });
}

/**
 * Resolve a texture dragged into the viewport (UE-style drop):
 *   1. ASPECT — load the texture once; when the decoded dims differ from the
 *      spawn card's square scale (dev catalog rows omit width/height, so the
 *      spawn always falls back to [2,2,1]), patch Transform to the
 *      aspect-correct card scale via setComponent.
 *   2. DEDUP — if the catalog already holds a MaterialAsset referencing this
 *      texture GUID, bind that material instead of minting a duplicate.
 *   3. Otherwise mint a new MaterialAsset named `M_<texture>` with the texture
 *      as baseColorTexture; `alphaCutoff` is set only when a pixel scan finds
 *      a non-opaque alpha channel (UE-Masked equivalent).
 *   4. Bind the material onto the spawned entity's MeshRenderer.
 * Every step goes through bus.dispatch (gateway): `createMaterial` is a
 * document op (undoable, writes to pack); `bindAssetRef` is a session op
 * (loadByGuid → allocSharedRef → setComponent).
 *
 * VISIBILITY BARRIER: createMaterial's applier returns ok synchronously while
 * its pack write lands fire-and-forget, and the served pack-index only
 * reflects the new GUID after the vite watcher rebuild (~150 ms). Dispatching
 * bindAssetRef immediately raced that rebuild — loadByGuid missed,
 * ASSET_NOT_FOUND aborted the bind, and the entity kept the engine's default
 * gray material FOREVER (no retry). Await the host-owned catalog barrier
 * (awaitPostAssetWriteCatalogSync) between the two dispatches; in unit env
 * (no hook registered) it resolves immediately.
 *
 * FAILURE DISCIPLINE (Fail Fast + user-visible): a texture that cannot be
 * loaded at all aborts the whole resolve BEFORE any material is authored;
 * a createMaterial rejection and a terminal bindAssetRef failure are both
 * surfaced through broadcastAssetsError (panel toast) — never a silent
 * gray-card degradation.
 */
async function resolveTexture(bus: EditGateway, renderer: RendererLike, entity: number, textureGuid: string, textureName: string | null, transform: { pos: [number, number, number]; scale: [number, number, number] } | null): Promise<void> {
  // ASPECT PATCH: dev-mode catalog rows deliberately omit width/height
  // (build-catalog reads JSON only), so the spawn fell back to a square
  // [2,2,1] card. The real pixel dims are only known after loadByGuid decodes
  // the image — patch the Transform here so a wide/tall texture drops as an
  // aspect-correct card instead of a squashed square. pos.y keeps the spawn
  // invariant (card bottom resting on the ground plane); x/z are preserved.
  const facts = await loadTextureSpawnFacts(renderer, textureGuid);
  if (facts === null) {
    // The texture itself cannot be loaded (phantom GUID — stale Content
    // Browser row whose source was deleted or failed to import, or a payload
    // the loader cannot decode). Fail Fast: surface a user-visible error and
    // ABORT. Continuing would write an orphan M_<name> material into the pack
    // whose baseColorTexture can never resolve — the entity would shade with
    // the default gray material forever with zero feedback (the exact failure
    // this resolver used to produce silently).
    const label = textureName ?? textureGuid;
    console.error('[drag-spawn-resolve:texture]', { textureGuid, code: 'texture-load-miss', hint: 'loadByGuid returned no decodable texture' });
    broadcastAssetsError({
      op: 'placeAsset',
      hint: `texture '${label}' could not be loaded — it may have been deleted, failed to import, or is still indexing; re-import it or retry once indexing completes`,
    });
    return;
  }
  if (transform !== null) {
    const scale = aspectCardScale(facts.width, facts.height);
    const drift =
      Math.abs(scale[0] - transform.scale[0]) +
      Math.abs(scale[1] - transform.scale[1]) +
      Math.abs(scale[2] - transform.scale[2]);
    if (drift > 1e-6) {
      const pos: [number, number, number] = [transform.pos[0], scale[1] / 2 + 0.01, transform.pos[2]];
      const r = bus.dispatch({ kind: 'setComponent', entity, component: 'Transform', patch: { pos, scale } }, 'ai');
      console.info(`[placement-diag] resolver.texture.aspect ${JSON.stringify({
        entity,
        textureGuid,
        width: facts.width,
        height: facts.height,
        scale,
        ok: r.ok,
        error: r.ok ? undefined : r.error,
      })}`);
    }
  }

  const guidKey = textureGuid.toLowerCase();
  const existing = bus.assetCatalog().find((row) =>
    row.kind === 'material'
    && (row.refs ?? []).some((g) => typeof g === 'string' && g.toLowerCase() === guidKey));
  if (existing !== undefined) {
    console.info(`[placement-diag] resolver.texture.dedup ${JSON.stringify({ entity, textureGuid, materialGuid: existing.guid })}`);
    dispatchMaterialBind(bus, entity, existing.guid, textureName ?? textureGuid);
    return;
  }

  const alphaCutoff = facts.alphaCutoff;
  const materialGuid = crypto.randomUUID();
  const materialName = `M_${textureName ?? textureGuid.slice(0, 8)}`;
  const r1 = bus.dispatch({
    kind: 'createMaterial',
    guid: materialGuid,
    name: materialName,
    baseColor: [1, 1, 1, 1],
    baseColorTexture: textureGuid,
    ...(alphaCutoff !== undefined ? { alphaCutoff } : {}),
  }, 'ai');
  if (!r1.ok) {
    // createMaterial rejects synchronously (INVALID_ARGS — e.g. the texture GUID
    // left the catalog between the load above and this dispatch). The spawn
    // already happened; the user must HEAR why the entity keeps the default
    // material instead of staring at a silent gray card.
    console.error('[drag-spawn-resolve:texture] createMaterial failed', r1);
    broadcastAssetsError({
      op: 'createMaterial',
      hint: `could not author material '${materialName}' for the dropped texture: ${r1.error.hint}`,
    });
    return;
  }
  try {
    await awaitPostAssetWriteCatalogSync(materialGuid);
  } catch (e) {
    // Barrier failed (visibility deadline / load miss): attempt the bind anyway —
    // a late pack-index row can still make it succeed, and the alternative is a
    // guaranteed default-gray entity.
    console.warn('[drag-spawn-resolve:texture] catalog visibility barrier failed; attempting bind anyway', e);
  }
  dispatchMaterialBind(bus, entity, materialGuid, materialName);
}

/** Bind a material GUID onto the spawned entity's MeshRenderer and surface a
 *  terminal bind failure (ASSET_NOT_FOUND etc.) through the panel error bus.
 *  bindAssetRef is a request-correlated session op: dispatch only ACCEPTS the
 *  run — the actual loadByGuid → allocSharedRef → setComponent effect resolves
 *  asynchronously, so a miss used to die invisibly inside the OperationRun. */
function dispatchMaterialBind(bus: EditGateway, entity: number, materialGuid: string, label: string): void {
  const requestId = crypto.randomUUID();
  const r = bus.dispatch({
    kind: 'bindAssetRef',
    entity,
    component: 'MeshRenderer',
    field: 'materials',
    assetType: 'MaterialAsset',
    guids: [materialGuid],
    requestId,
  }, 'ai');
  if (!r.ok) {
    console.error('[drag-spawn-resolve:texture] bindAssetRef dispatch rejected', r);
    broadcastAssetsError({
      op: 'bindAssetRef',
      hint: `could not bind material '${label}' onto the dropped texture card: ${r.error.hint}`,
    });
    return;
  }
  void bus.waitOperationRun(requestId).then((run) => {
    if (run.ok && run.value.status === 'succeeded') return;
    const hint = run.ok
      ? (run.value.error?.hint ?? `bind run ended with status '${run.value.status}'`)
      : run.error.hint;
    console.error('[drag-spawn-resolve:texture] bindAssetRef run failed', { requestId, materialGuid, hint });
    broadcastAssetsError({
      op: 'bindAssetRef',
      hint: `could not bind material '${label}' onto the dropped texture card: ${hint}`,
    });
  });
}

/** Card scale for a texture of the given pixel dims — mirrors the
 *  `textureScale` rule in core/assets/drag-asset-spawn.ts (base edge 2, the
 *  longer side wins, z is always 1 on the flat HANDLE_QUAD card). Derive-don't-
 *  duplicate note: the spawn-time copy runs on catalog payload dims (absent in
 *  dev mode); this copy runs on the DECODED dims, so it is the authoritative
 *  aspect correction. */
function aspectCardScale(width: number, height: number): [number, number, number] {
  const base = 2;
  const aspect = width / height;
  return aspect >= 1 ? [base, base / aspect, 1] : [base * aspect, base, 1];
}

/**
 * Load a texture once and return the spawn-resolution facts: decoded pixel
 * dims (for the aspect patch) plus the UE-Masked cutoff (0.5) when a raw-RGBA
 * pixel scan finds any non-opaque alpha. Returns null on any load/parse
 * failure — the caller then aborts the whole resolve with a user-visible
 * error (a material referencing an unloadable texture can never render).
 * UNDECIDABLE alpha payloads (GPU-compressed KTX2/Basis bytes carry
 * no scannable RGBA) yield the dims with no cutoff, the safe default.
 */
async function loadTextureSpawnFacts(renderer: RendererLike, textureGuid: string): Promise<{ width: number; height: number; alphaCutoff?: number } | null> {
  try {
    const parsed = AssetGuid.parse(textureGuid);
    if (!parsed.ok) return null;
    const res = await renderer.assets.loadByGuid(parsed.value);
    if (!res.ok || res.value === undefined) return null;
    const tex = res.value as { width?: unknown; height?: unknown; format?: unknown; data?: unknown };
    if (typeof tex.width !== 'number' || typeof tex.height !== 'number' || tex.width <= 0 || tex.height <= 0) return null;
    let alphaCutoff: number | undefined;
    if (
      (tex.format === 'rgba8unorm' || tex.format === 'rgba8unorm-srgb')
      && tex.data instanceof Uint8Array
      && tex.data.length >= tex.width * tex.height * 4
    ) {
      for (let a = 3; a < tex.data.length; a += 4) {
        if ((tex.data[a] ?? 255) < 255) { alphaCutoff = 0.5; break; }
      }
    }
    return { width: tex.width, height: tex.height, ...(alphaCutoff !== undefined ? { alphaCutoff } : {}) };
  } catch {
    return null;
  }
}
