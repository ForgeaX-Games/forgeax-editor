// store/ref-request — "pin this entity/component/asset into the ForgeaX chat".
//
// State: none — a stateless function cluster that reads gateway.doc and emits
// deixis handles over the typed editor bus. The chat panel (in the same host
// window since single-realm M2/M4) subscribes via panelBridge.on('editorRef').
//
// Anchors:
//   plan-strategy §2 D-2: cluster 8 (store.ts:227-281)
//   plan-strategy §2 D-1: cross-module deps are explicit imports (gateway,
//     entity-state helpers).
//   requirements AC-09: pure structural migration.
import { gateway } from './gateway';
import { entExists, entName, entComponents } from './entity-state';
import type { EntityId } from '../types';
import type { AssetChatRef } from '../io/cross-panel-types';
import { panelBridge } from '../io/panel-bridge';

export function requestRefEntity(id: EntityId): void {
  if (!entExists(gateway.doc, id)) return;
  panelBridge.emit('editorRef', {
    kind: 'entity',
    id,
    name: entName(gateway.doc, id),
    components: Object.keys(entComponents(gateway.doc, id)),
  });
}

/** Pin a COMPONENT from the inspector into the ForgeaX chat — kind='component'. */
export function requestRefComponent(entityId: EntityId, comp: string, value: unknown): void {
  if (!entExists(gateway.doc, entityId)) return;
  panelBridge.emit('editorRef', {
    kind: 'component',
    entityId,
    entityName: entName(gateway.doc, entityId),
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
