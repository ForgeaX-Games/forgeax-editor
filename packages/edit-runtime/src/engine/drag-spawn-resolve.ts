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
// This module subscribes to the EditorBus and, for each spawnEntity command that
// carries the marker, resolves the real asset GUID to a mesh handle and patches
// MeshFilter.assetHandle over the bus:
//   AssetGuid.parse(guid) -> renderer.assets.loadByGuid -> world.allocSharedRef(
//   'MeshAsset', payload) -> bus.dispatch(setComponent MeshFilter{assetHandle}, 'ai')
//
// WHY over the bus and not world.set directly (plan-strategy §D-4): the EditorBus
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
import { EditorBus, type EditorCommand } from '@forgeax/editor-core';

/** Loose engine handles — the ECS/renderer types evolve independently, so we
 *  mirror host-boot's `as never` discipline with narrow structural shapes. */
type WorldLike = {
  allocSharedRef(brand: string, payload: unknown): number;
};
type RendererLike = {
  assets: {
    loadByGuid(guid: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code?: string } }>;
  };
};

/** Pull the pending-mesh marker guid from a spawnEntity command, or null. */
function pendingMeshGuid(cmd: EditorCommand | null): string | null {
  if (cmd === null || cmd.kind !== 'spawnEntity') return null;
  const marker = cmd.components?.EditorPendingMeshAsset as { guid?: unknown } | undefined;
  const guid = marker?.guid;
  return typeof guid === 'string' && guid.length > 0 ? guid : null;
}

/**
 * Subscribe the drag-spawn mesh resolver to the EditorBus. Idempotent per GUID:
 * failed GUIDs are never retried, resolved GUIDs are re-patched from cache.
 */
export function installDragSpawnMeshResolver(bus: EditorBus, world: WorldLike, renderer: RendererLike): void {
  const failed = new Set<string>();
  const resolved = new Map<string, number>();

  const patch = (entity: number, assetHandle: number): void => {
    bus.dispatch({ kind: 'setComponent', entity, component: 'MeshFilter', patch: { assetHandle } }, 'ai');
  };

  bus.subscribe((_doc, lastCommand) => {
    const guid = pendingMeshGuid(lastCommand);
    if (guid === null) return;
    // lastCommand is a spawnEntity here; applyCommand fills _id (document.ts).
    const entity = (lastCommand as Extract<EditorCommand, { kind: 'spawnEntity' }>)._id;
    if (typeof entity !== 'number') return;

    // Retry-storm guard: a GUID that already failed is never re-attempted.
    if (failed.has(guid)) return;
    // Cache hit (redo replay / second entity sharing the mesh): re-patch, no reload.
    const cached = resolved.get(guid);
    if (cached !== undefined) { patch(entity, cached); return; }

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
      const handle = world.allocSharedRef('MeshAsset', res.value);
      resolved.set(guid, handle);
      patch(entity, handle);
    })();
  });
}
