// store/ref-request — "pin this entity/component/asset into the ForgeaX chat".
//
// State: none — a stateless function cluster that reads bus.doc and posts deixis
// handles up the VAG postMessage channel (the chat panel lives in the parent
// interface shell; we are an iframe, so ref state is not owned locally). This is
// exactly the "human points → AI gets a concrete handle" path.
//
// Anchors:
//   plan-strategy §2 D-2: cluster 8 (store.ts:227-281)
//   plan-strategy §2 D-1: cross-module deps are explicit imports (bus,
//     entity-state helpers).
//   requirements AC-09: pure structural migration.
import { bus } from './bus';
import { entExists, entName, entComponents } from './entity-state';
import type { EntityId } from '../types';
import type { AssetChatRef } from '../io/cross-panel-types';

// Reference-request signal: "pin entity N into the ForgeaX chat context". The
// chat panel lives in the parent interface shell (we are an iframe), so we post
// a deixis handle up via the VAG postMessage channel rather than owning ref
// state locally — exactly the "human points → AI gets a concrete handle" path.
export function requestRefEntity(id: EntityId): void {
  // M7 / AC-15: entity name + component keys read from world (SSOT) via
  // entity-state helpers; doc.entities dual-write mirror deleted.
  if (!entExists(bus.doc, id)) return;
  const handle = {
    kind: 'entity' as const,
    id,
    name: entName(bus.doc, id),
    components: Object.keys(entComponents(bus.doc, id)),
  };
  try {
    window.parent?.postMessage({ type: 'VAG_EDITOR_REF', payload: handle }, '*');
  } catch {
    /* cross-origin — non-fatal */
  }
}

/** Pin a COMPONENT from the inspector into the ForgeaX chat — kind='component'. */
export function requestRefComponent(entityId: EntityId, comp: string, value: unknown): void {
  // M7 / AC-15: entity name read from world (SSOT); doc.entities mirror deleted.
  if (!entExists(bus.doc, entityId)) return;
  try {
    window.parent?.postMessage(
      { type: 'VAG_EDITOR_REF', payload: { kind: 'component', entityId, entityName: entName(bus.doc, entityId), comp, value } },
      '*',
    );
  } catch { /* cross-origin — non-fatal */ }
}

/** Pin an ASSET (material/texture/mesh) into the ForgeaX chat as a deixis handle
 * — same channel as requestRefEntity, payload.kind === 'asset'. */
export function requestRefAsset(asset: { guid: string; kind: string; name: string; packPath?: string }): void {
  try {
    window.parent?.postMessage(
      { type: 'VAG_EDITOR_REF', payload: { kind: 'asset', guid: asset.guid, assetKind: asset.kind, name: asset.name, packPath: asset.packPath } },
      '*',
    );
  } catch {
    /* cross-origin — non-fatal */
  }
}

/** Batch-add asset/folder refs into the ForgeaX AI Chat context (M5).
 *  Carries full payload so the AI can reason about asset contents. */
export function requestAddAssetsToChat(refs: AssetChatRef[]): void {
  if (refs.length === 0) return;
  try {
    window.parent?.postMessage(
      { type: 'FORGEAX_ADD_ASSET_TO_CHAT', refs },
      '*',
    );
  } catch {
    /* cross-origin — non-fatal */
  }
}

// requestAddAssetToScene lives in ./spawn-asset-ref (co-located with
// spawnAssetRefToScene it wraps) so store does not depend on spawn-asset-ref —
// keeping the intra-core edge one-directional (spawn-asset-ref → store). It is
// still re-exported from the barrel, so consumers are unaffected.
