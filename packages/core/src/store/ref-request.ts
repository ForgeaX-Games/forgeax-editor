// store/ref-request — "pin this entity/component/asset into the ForgeaX chat".
//
// State: none — a stateless function cluster that reads gateway.activeWorld and
// emits deixis handles over the typed editor bus. The chat panel (in the same
// host window since single-realm M2/M4) subscribes via panelBridge.on('editorRef').
//
// Anchors:
//   plan-strategy §2 D-2: cluster 8 (store.ts:227-281)
//   plan-strategy §2 D-1: cross-module deps are explicit imports (gateway,
//     entity-state helpers).
//   requirements AC-09: pure structural migration.
import { gateway } from './gateway';
import { entExists, entName, entComponents } from './entity-state';
import type { EntityHandle } from '../scene/scene-types';
import type { AssetChatRef } from '../io/cross-panel-types';
import { panelBridge } from '../io/panel-bridge';

// M3 (I1): the deixis handle IS the engine EntityHandle read off activeWorld;
// transport is the typed editor bus (panelBridge.emit('editorRef'), #74) which
// the chat panel subscribes to via panelBridge.on('editorRef') in the same host
// window (single-realm M2/M4).
export function requestRefEntity(handle: EntityHandle): void {
  const world = gateway.activeWorld;
  if (!entExists(world, handle)) return;
  panelBridge.emit('editorRef', {
    kind: 'entity',
    id: handle,
    name: entName(world, handle),
    components: Object.keys(entComponents(world, handle)),
  });
}

/** Pin a COMPONENT from the inspector into the ForgeaX chat — kind='component'. */
export function requestRefComponent(entity: EntityHandle, comp: string, value: unknown): void {
  const world = gateway.activeWorld;
  if (!entExists(world, entity)) return;
  panelBridge.emit('editorRef', {
    kind: 'component',
    entityId: entity,
    entityName: entName(world, entity),
    comp,
    value,
  });
}

/** Pin an ASSET (material/texture/mesh) into the ForgeaX chat as a deixis handle
 * — same channel as requestRefEntity, payload.kind === 'asset'. */
export function requestRefAsset(asset: { guid: string; kind: string; name: string; packPath?: string }): void {
  panelBridge.emit('editorRef', {
    kind: 'asset',
    guid: asset.guid,
    assetKind: asset.kind,
    name: asset.name,
    packPath: asset.packPath,
  });
}

/** Batch-add asset/folder refs into the ForgeaX AI Chat context (M5).
 *  Carries full payload so the AI can reason about asset contents. */
export function requestAddAssetsToChat(refs: AssetChatRef[]): void {
  if (refs.length === 0) return;
  panelBridge.emit('addAssetToChat', refs);
}

// requestAddAssetToScene lives in ./spawn-asset-ref (co-located with
// spawnAssetRefToScene it wraps) so store does not depend on spawn-asset-ref —
// keeping the intra-core edge one-directional (spawn-asset-ref → store). It is
// still re-exported from the barrel, so consumers are unaffected.
