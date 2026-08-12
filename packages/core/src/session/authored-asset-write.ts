// session/authored-asset-write — the ONE authored-pack-asset commit contract.
//
// Extracted from pack-ops so every authored asset kind reaches disk, the live
// catalog, and the UI through the same barrier — including Material Instances,
// whose applier must NOT import pack-ops (that would drag io/appliers →
// session/document → engine-scene into the MI unit tests).
//
// WHY A BARRIER AT ALL
//   A pack write resolving means the BYTES landed; it does NOT mean the asset
//   is consumable. The host's pack-index watcher rebuilds the served catalog
//   asynchronously (~150 ms debounce), so a broadcastAssetsChanged() fired the
//   moment the write resolves races that rebuild: the Content Browser refreshes
//   against a pack-index that still predates the write and the freshly authored
//   asset is INVISIBLE until a later watcher tick or a page reload. Awaiting the
//   host hook before broadcasting is what makes "created" mean "visible".
//
// Anchors: .forgeax-harness/docs/2026-08-05-material-instance-editor-tech-plan.md §A3,
//   AGENTS.md invariant 7 (one door), architecture-principles #1 (SSOT).

import { broadcastAssetsChanged } from '../store/assets-changed';
import { broadcastAssetsError } from '../store/assets-error-bus';
import type { ApplyResult, EditorOp } from '../types';

/** Narrow write surface every authored-asset applier shares. Deliberately not
 *  DocApplierCtx: the MI appliers build their own minimal ctx. */
export interface AuthoredAssetWriteCtx {
  readonly assetIO: {
    createAssetInPack(args: {
      packPath: string;
      asset: { guid: string; kind: string; name: string; payload: unknown; refs?: string[] };
    }): Promise<{ ok: true } | { ok: false; reason: string; hint: string }>;
  };
}

export interface AuthoredAssetWrite {
  readonly guid: string;
  readonly kind: string;
  readonly name: string;
  readonly payload: unknown;
  readonly refs?: string[];
}

// ── Post-write catalog-sync seam ─────────────────────────────────────────────
// The host (edit-runtime, which owns gateway.doc.registry) registers an async
// hook that (a) waits until the pack-index row for the new GUID is actually
// served and (b) catalogs the payload envelope. Null until registered (unit env
// / no host): callers then broadcast immediately, as before.
let postAssetWriteCatalogSync: ((guid: string) => Promise<void>) | null = null;
const pendingAssetWrites = new Map<string, Promise<void>>();

/** Host seam: edit-runtime registers a hook that waits for the pack-index row
 *  of a freshly written asset and catalogs its envelope, so the post-write
 *  broadcast never races the watcher rebuild. Pass null to clear (tests /
 *  realm teardown). */
export function registerPostAssetWriteCatalogSync(fn: ((guid: string) => Promise<void>) | null): void {
  postAssetWriteCatalogSync = fn;
}

/** In-flight dedupe for the catalog barrier: two callers racing the same GUID
 *  (e.g. the createMaterial applier's own continuation AND a second barrier
 *  from the drop resolver) must share ONE host-hook invocation — otherwise the
 *  host runs duplicate refresh/load cycles and doubles any `/__import`
 *  fallback attempts. Resolved entries are dropped so a LATER write of the same
 *  guid (delete → re-create) runs a fresh barrier. */
const catalogBarrierInflight = new Map<string, Promise<void>>();

/** Await the host-owned catalog visibility barrier for a newly written asset or
 * scene pack. The producer remains the owner of the write; the host owns the
 * pack-index/catalog visibility barrier before a navigation/load can consume it.
 * Concurrent waits for the same guid share a single host-hook invocation. */
export function awaitPostAssetWriteCatalogSync(guid: string): Promise<void> {
  if (!postAssetWriteCatalogSync) return Promise.resolve();
  const inflight = catalogBarrierInflight.get(guid);
  if (inflight) return inflight;
  const p = postAssetWriteCatalogSync(guid);
  const tracked = p.then(
    () => { if (catalogBarrierInflight.get(guid) === tracked) catalogBarrierInflight.delete(guid); },
    (e) => { if (catalogBarrierInflight.get(guid) === tracked) catalogBarrierInflight.delete(guid); throw e; },
  );
  catalogBarrierInflight.set(guid, tracked);
  return tracked;
}

// ── Authored-asset completion contract ────────────────────────────────────────
// "createMaterial / createMaterialInstance is DONE" is not the synchronous
// dispatch (that only commits the undo ledger) — it is: pack write landed on
// disk AND the catalog barrier observed the new GUID. Callers that follow the
// create with bindAssetRef (viewport drop resolver, content-browser context
// menu) MUST await awaitAuthoredMaterialReady(guid) and abort the bind when it
// is not ok — otherwise a failed/clobbered write surfaces as a permanently gray
// material whose bind falls back to `/__import/{guid}` 404s.
export type AuthoredMaterialWriteStage = 'write' | 'catalog';

export type AuthoredMaterialReadiness =
  | { readonly ok: true }
  | { readonly ok: false; readonly stage: AuthoredMaterialWriteStage; readonly hint: string };

/** Bounded FIFO map (evict oldest) — create completions are awaited shortly
 *  after dispatch; 256 concurrent in-flight assets is far beyond any realistic
 *  burst, and the bound prevents unbounded growth if a caller never awaits. */
const TRACKED_WRITES_LIMIT = 256;
const authoredMaterialWrites = new Map<string, Promise<AuthoredMaterialReadiness>>();

function trackAuthoredMaterialWrite(guid: string, completion: Promise<AuthoredMaterialReadiness>): void {
  if (authoredMaterialWrites.size >= TRACKED_WRITES_LIMIT) {
    const oldest = authoredMaterialWrites.keys().next().value;
    if (oldest !== undefined) authoredMaterialWrites.delete(oldest);
  }
  authoredMaterialWrites.set(guid, completion);
}

/** Bare barrier wrapped as a readiness result — the fallback for GUIDs the
 *  tracking map does not know (unit envs, or an op applied before this module
 *  version tracked it). */
async function bareCatalogBarrier(guid: string): Promise<AuthoredMaterialReadiness> {
  try {
    await awaitPostAssetWriteCatalogSync(guid);
    return { ok: true };
  } catch (e) {
    return { ok: false, stage: 'catalog', hint: e instanceof Error ? e.message : String(e) };
  }
}

/** The single "authored material (or material instance) is consumable"
 *  contract. Resolves the tracked write+catalog completion when this module
 *  scheduled the write; otherwise degrades to the bare catalog barrier. Callers
 *  MUST branch on the result and abort the follow-up bind when `!ok`. */
export function awaitAuthoredMaterialReady(guid: string): Promise<AuthoredMaterialReadiness> {
  return authoredMaterialWrites.get(guid) ?? bareCatalogBarrier(guid);
}

// ── Authored-inline-asset tracker seam (scene-save protection) ────────────────
// A material created AFTER the scene was loaded is not covered by the save
// path's loadedInlineAssetFloor / loadedInlineAssets baseline (captured at
// load). Without this seam a concurrent scene save can persist a pack body
// that DROPS the freshly authored material. scene-persistence registers
// track/untrack hooks here; destroyAsset calls untrack after a successful
// delete (symmetric — undo/delete must not leave a stale floor bump protecting
// a guid that no longer exists on disk).
export interface AuthoredInlineAssetSnapshot {
  readonly guid: string;
  readonly packPath: string;
  readonly kind: string;
  readonly name?: string;
  /** Full pack-entry body (payload + refs) so the save path's orphan-merge can
   *  re-append the asset verbatim if a save lands before any entity refs it. */
  readonly payload?: unknown;
  readonly refs?: readonly string[];
}

let authoredInlineAssetTracker: ((snapshot: AuthoredInlineAssetSnapshot) => void) | null = null;
let authoredInlineAssetUntracker: ((guid: string) => void) | null = null;

/** Host seam: scene-persistence registers hooks that keep the save path's
 *  inline-asset baseline in sync with post-load authored material writes.
 *  Pass null to clear (tests / realm teardown). */
export function registerAuthoredInlineAssetTracker(
  track: ((snapshot: AuthoredInlineAssetSnapshot) => void) | null,
  untrack?: ((guid: string) => void) | null,
): void {
  authoredInlineAssetTracker = track;
  authoredInlineAssetUntracker = untrack ?? null;
}

export function trackAuthoredInlineAsset(snapshot: AuthoredInlineAssetSnapshot): void {
  authoredInlineAssetTracker?.(snapshot);
}

export function untrackAuthoredInlineAsset(guid: string): void {
  authoredInlineAssetUntracker?.(guid);
}

// ── Pending-write registry (product OperationRun completion barrier) ──────────

/** Await the complete authored-asset commit: disk write, live catalog row, and
 * payload load. Product operations use this barrier so synchronous success
 * never means merely "the write was scheduled". */
export async function awaitAssetWriteCompletion(guid: string): Promise<void> {
  const pending = pendingAssetWrites.get(guid.toLowerCase());
  if (!pending) throw new Error(`No authored-asset write is pending for GUID ${guid}.`);
  await pending;
}

/** Register a fire-and-forget asset mutation so awaitAssetWriteCompletion can
 *  observe it, keeping the rejection handled and the map self-pruning. */
export function trackPendingAssetWrite(
  guid: string,
  completion: Promise<void>,
  onFailure: (error: unknown) => void,
): void {
  const writeKey = guid.toLowerCase();
  pendingAssetWrites.set(writeKey, completion);
  void completion
    .catch(onFailure)
    .finally(() => {
      if (pendingAssetWrites.get(writeKey) === completion) pendingAssetWrites.delete(writeKey);
    });
}

/**
 * Commit one authored asset through the editor-owned write gate.
 *
 * Document appliers stay synchronous so they can return an undo inverse, while
 * the product adapter awaits this shared completion barrier before declaring
 * its outer OperationRun successful. Every authored asset kind therefore gets
 * identical disk-write, live-catalog visibility, notification, and failure
 * semantics without operation-name branching.
 */
export function scheduleAuthoredAssetWrite(
  ctx: AuthoredAssetWriteCtx,
  targetPack: string,
  asset: AuthoredAssetWrite,
): ApplyResult {
  const opName = `create${asset.kind[0]?.toUpperCase() ?? ''}${asset.kind.slice(1)}`;
  const readiness: Promise<AuthoredMaterialReadiness> = (async () => {
    const write = await ctx.assetIO.createAssetInPack({ packPath: targetPack, asset })
      .catch((cause): { ok: false; reason: 'write-failed'; hint: string } => ({
        ok: false,
        reason: 'write-failed',
        hint: cause instanceof Error ? cause.message : String(cause),
      }));
    if (!write.ok) {
      const hint = `${write.reason}: ${write.hint}`;
      broadcastAssetsError({
        op: opName,
        path: targetPack,
        hint: `authored ${asset.kind} write failed (${hint})`,
      });
      return { ok: false, stage: 'write', hint };
    }
    try {
      await awaitPostAssetWriteCatalogSync(asset.guid);
    } catch (cause) {
      const hint = cause instanceof Error ? cause.message : String(cause);
      broadcastAssetsError({
        op: opName,
        path: targetPack,
        hint: `authored ${asset.kind} catalog visibility failed: ${hint}`,
      });
      broadcastAssetsChanged();
      return { ok: false, stage: 'catalog', hint };
    }
    broadcastAssetsChanged();
    return { ok: true };
  })();
  trackAuthoredMaterialWrite(asset.guid, readiness);
  const completion = readiness.then((result) => {
    if (!result.ok) throw new Error(`${result.stage}: ${result.hint}`);
  });
  trackPendingAssetWrite(
    asset.guid,
    completion,
    (error) => console.warn(`[editor-core] create ${asset.kind} asset commit failed:`, error),
  );
  return {
    ok: true,
    inverse: { kind: 'destroyAsset', _resolvedPackPath: targetPack, guid: asset.guid } as unknown as EditorOp,
    created: [],
  };
}
