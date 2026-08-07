// store/persistence/disk-io — the HIGH SIDE-EFFECT persistence cluster of the
// game's authored scene: disk load / save, engine-native world<->pack
// serialization, canonical loadByGuid -> instantiate scene-load, and the
// unload-time save beacon.
//
// M2 (w6): this is a `createDiskIo(deps)` DI factory (the run-lifecycle
// `create<Thing>(deps)` pattern). Everything that reaches OUTSIDE the module —
// the network (fetch / fetchWithTimeout), the live engine world
// (gateway.doc), the host path resolver, and the persistence state handle
// (ScenePersistenceContext) — arrives THROUGH `deps`, so a reader sees the whole
// dependency edge in the factory signature and a headless test injects fakes for
// every one (AC-02). scene-persistence.ts is the composition root: it builds ONE
// createDiskIo with the real gateway / fetch / fetchWithTimeout and re-exports
// the resulting functions (barrel surface unchanged, consumers zero-change).
//
// D-2 fetch-as-dep (the core R-6 seam): `fetch` injected via deps. This is a
// STRUCTURAL change (allowed by plan-strategy §2 D-2) — the transport body is the
// platform fetch (OOS-5). The injected value is arrow-wrapped in production, so
// every network read goes through deps.fetch / deps.fetchWithTimeout, never a raw
// hardcoded-transport call.
//
// D-8 (fan_in avoidance): this file lives under store/persistence/ and is NOT
// re-exported from the core index.ts top-level barrel — only scene-persistence.ts
// (already in the store barrel) composes + forwards it, so core's index.ts fan_in
// (42) does not rebound (plan-strategy §2 D-8 / R-4).
//
// OOS-1 (zero behavior change): every body here is the verbatim logic previously
// in scene-persistence.ts; the only edits are `fetch`/`fetchWithTimeout`/
// `gateway.doc`/`resolveGamePath` reads re-pointed at `deps`. The 0-byte
// data-loss guards (serialize-fail aborts the write; inline-asset preservation
// net) are preserved exactly (AGENTS.md #2).
//
// Anchors:
//   (forward) plan-strategy feat-20260709-editor-large-file-di-decompose-wave2-c-domain-scen
//     plan-id; AC-01/AC-02 (DI factory, headless-injectable, no singleton read) +
//     AC-08 (core max_file_loc drop) + AC-07 (bidirectional anchors);
//     plan-strategy §2 D-2 (fetch via deps) + D-8 (subdir landing) + §8 naming
//     (create<Thing> / <Thing>Deps).
//   (backward) extracted from store/scene-persistence.ts (this loop's target),
//     itself split out of store.ts by historical feat
//     feat-20260705-editor-core-engine-convergence-store-ts-decompose.
import { canonicalScenePackRevision, isScenePack, normalizePackForRuntime, stableGuid, validatePackShell } from '../../scene/scene-pack';
import { rootsToSceneAsset, serializeSceneAssetToPack } from '@forgeax/engine-runtime';
import { createEditSession } from '../../session/document';
import { createPackResourceChange } from '../../session/pack-ops';
import { worldRootHandles } from '../entity-state';
import type { ScenePersistenceContext, LoadedInlineSnapshot } from '../scene-persistence';
import type { CommandError, EditorOp, EditSession } from '../../types';
import type { EntityHandle, WorldType } from '../../scene/scene-types';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { SceneAsset } from '@forgeax/engine-types';
import { assetIO, type AssetResourceTransactionPort } from '../../io/asset-io-facade';
import type { ImportedPreviewSessionState } from '../../io/scene-authoring-session';
import { normalizeAnimationPlayerSceneAsset } from '../../scene/animation-slot-sync';
import { normalizeMaterialPackEntries } from '../../io/material-pack-refs';
import { normalizeMaterialInstancePackEntries } from '../../assets/material-instance-schema';

/** The single-pointer gateway surface disk-io needs — a structural mirror of
 *  EditGateway (the same DI shape run-lifecycle's RunGateway uses). Headless
 *  tests supply a fake carrying a null-world doc; production passes the real
 *  gateway singleton. */
export interface PersistenceGateway {
  /** The live authoring document (world + registry). Read on every serialize /
   *  scene-load; null world/registry short-circuits headlessly. */
  readonly doc: EditSession;
  /** Monotonic authored revision used by the save revision collar. */
  readonly rev?: number;
  /** Replace the whole authoring document (scene swap). */
  replaceDoc(doc: EditSession): void;
  /** Dispatch a session op (used by replaceDoc to clear selection). */
  dispatch(op: EditorOp): { ok: boolean };
}

export interface SaveDocToDiskOptions {
  /** Revision captured when Gateway accepted this save request. */
  readonly acceptedRevision?: number;
}

export interface SaveDocToDiskCommit {
  readonly path: string;
  readonly committedRevision: string;
  readonly acceptedRevision: number;
  readonly currentRevision: number;
  /** Whether the authored document was clean after applying the revision collar. */
  readonly dirty: boolean;
}

export type SaveDocToDiskResult =
  | { readonly ok: true; readonly result: SaveDocToDiskCommit }
  | { readonly ok: false; readonly error: CommandError };

/**
 * Normalize a loaded scene without severing its catalog provenance. The
 * animation compatibility pass intentionally returns a clone because the
 * registry's loaded payload is cached/shared. That clone becomes the payload
 * held by live SceneInstance.source handles, so it must replace the catalog
 * payload under the same GUID before instantiate/collect can reverse-lookup it
 * during save. Preserve the original envelope refs when re-cataloguing; those
 * refs carry the imported package's shared-asset edges.
 */
function normalizeAndCatalogSceneAsset(
  registry: AssetRegistry,
  guid: string,
  loaded: SceneAsset,
): SceneAsset {
  const normalized = normalizeAnimationPlayerSceneAsset(loaded);
  const existing = registry.assetCatalog.get(guid.toLowerCase());
  const cataloged = registry.catalog(guid, normalized, existing?.refs);
  if (!cataloged.ok) {
    throw new Error(`normalized scene catalog failed: ${cataloged.error.code}`);
  }
  return cataloged.value as SceneAsset;
}

/**
 * Everything createDiskIo needs, declared explicitly (Pipeline Isolation). No
 * implicit module globals — the headless test supplies a fake ctx + fake
 * gateway + fake fetch / fetchWithTimeout that never touch the network.
 */
export interface DiskIoDeps {
  /** The persistence-state handle (7 formerly-singleton fields). All state reads
   *  and writes go through this — never a module-level `let`. */
  readonly ctx: ScenePersistenceContext;
  /** The gateway (live doc + replaceDoc + dispatch). */
  readonly gateway: PersistenceGateway;
  /** The injected fetch (D-2 / R-P1). Production = arrow-wrapped platform fetch;
   *  headless test = a fake that records calls and never hits the network. */
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Timeout-guarded fetch for GET reads (io/net.ts fetchWithTimeout). Injected
   *  so headless tests drive load/echo-compare without a server. */
  readonly fetchWithTimeout: (url: string, ms?: number) => Promise<Response>;
  /** Host path resolver — game-relative name -> absolute /api path. Injected so
   *  a headless test controls it without installing a global resolver. */
  readonly resolveGamePath: (rel: string) => string;
  /** Signal a doc reload to React consumers (doc-version). */
  readonly notifyDocChanged: () => void;
  /** Optional headless serializer seam. Production uses the canonical engine
   *  serializer below; tests inject bytes to exercise each guard deterministically. */
  readonly serializeForSave?: (doc: EditSession, sceneGuid?: string) => string | null;
  /** Optional headless resource transaction seam. Production continues through
   *  the shared assetIO facade and its platform resource protocol. */
  readonly prepareResourceTransaction?: AssetResourceTransactionPort['prepare'];
  /** Optional last-resort save used by flushPendingSaveBeacon when the beacon
   *  Blob path throws — the composition root wires the public dispatch wrapper so
   *  the fallback still records a ledger entry (OOS-1). Omitted in headless. */
  readonly saveDocToDiskViaDispatch?: () => void;
}

/** The high-side-effect surface createDiskIo returns. disk-watch consumes
 *  worldToPack / scenePath / loadSceneByGuid off the composed instance (via the
 *  scene-persistence re-exports); the rest are the public save/load/switch impls
 *  the composition root wraps + re-exports. */
export interface DiskIo {
  scenePath(): string | null;
  worldToPack(doc: EditSession, sceneGuid?: string): string | null;
  stripEditorHiddenMarker(asset: unknown): unknown;
  inlineAssetCount(pack: unknown): number;
  loadSceneByGuid(sceneGuid: string): Promise<boolean>;
  loadImportedScenePreviewState(facts: {
    readonly guid: string;
    readonly sourceKey: string;
    readonly revision: string;
  }): Promise<ImportedPreviewSessionState | null>;
  instantiateSceneRefUnderWorld(sceneGuid: string, parentHandle: number): Promise<number | null>;
  resolveAssetRefToHandle(guid: string, assetType: string): Promise<
    | { ok: true; value: number }
    | { ok: false; error: { code: string; hint: string; detail?: unknown } }
  >;
  doLoadDocFromDisk(): Promise<boolean>;
  doSaveDocToDisk(options?: SaveDocToDiskOptions): Promise<SaveDocToDiskResult>;
  flushPendingSaveBeacon(): void;
  replaceDoc(doc: EditSession): void;
}

/** Remove the editor-only `EditorHidden` marker from a collected SceneAsset's
 *  entities so it never lands in the persisted pack (AC-04), while the entities
 *  themselves stay (AC-05). The derived engine `Disabled` marker (synced by
 *  applySetHidden so hidden entities leave the viewport render) is stripped
 *  alongside — hide state is editor-only; Play must show every entity (UE PIE
 *  parity, docs 2026-08-04-editor-hide-ue-parity-plan §3.3).
 *  SceneAsset/entities are readonly, so rebuild.
 *  Pure — no deps; exported standalone so scene-persistence re-exports it. */
export function stripEditorHiddenMarker(asset: unknown): unknown {
  const a = asset as { kind: string; entities?: ReadonlyArray<{ localId: unknown; components: Record<string, unknown> }> };
  if (!a || !Array.isArray(a.entities)) return asset;
  return {
    ...a,
    entities: a.entities.map((e) => {
      if (!e.components) return e;
      const hasHidden = 'EditorHidden' in e.components;
      const hasDisabled = 'Disabled' in e.components;
      if (!hasHidden && !hasDisabled) return e;
      const { EditorHidden: _dropH, Disabled: _dropD, ...rest } = e.components;
      return { ...e, components: rest };
    }),
  };
}

/** Count the inline (non-scene) asset entries in a serialized pack object —
 *  the material/texture/etc. bodies that must survive a save round-trip. Used
 *  by the saveDocToDisk safety net to refuse a write that would drop them.
 *  Pure — no deps. */
export function inlineAssetCount(pack: unknown): number {
  const assets = (pack as { assets?: ReadonlyArray<{ kind?: string }> })?.assets;
  if (!Array.isArray(assets)) return 0;
  return assets.filter((a) => a?.kind !== 'scene').length;
}

/** Pure floor comparison behind the material-strip safety net (#101; exported for
 *  unit test and re-exported by scene-persistence for the store.ts barrel). true
 *  ⇒ writing `newPack` would strip inline assets below `floor` and must be refused.
 *  `floor === null` (no scene loaded) ⇒ never drops, so first-time saves proceed.
 *  Anchoring to the LOAD floor (not the current on-disk count) is what defeats the
 *  strip-loop: a prior stripping write can't lower the bar (the old count-vs-disk
 *  guard let 0 >= 0 through forever), and this is a pure sync check so the pagehide
 *  beacon — which cannot await a disk read — uses the exact same guard. */
export function wouldDropInlineAssets(floor: number | null, newPack: unknown): boolean {
  if (floor === null) return false;
  return inlineAssetCount(newPack) < floor;
}

/** Entity-count safety net: true when the serialized pack has zero entities but
 *  the scene loaded from disk had a non-zero entity count. Prevents an empty world
 *  (e.g. after a failed loadSceneByGuid teardown or a stale cache miss) from
 *  permanently overwriting a valid scene file. `loadedEntityFloor === null` means
 *  no scene was loaded — first-time saves proceed. Exported for unit tests. */
export function wouldDropAllEntities(loadedEntityFloor: number | null, newPack: unknown): boolean {
  if (loadedEntityFloor === null || loadedEntityFloor === 0) return false;
  const scene = (newPack as { assets?: Array<{ kind?: string; payload?: { entities?: unknown[] } }> })?.assets;
  if (!Array.isArray(scene)) return false;
  const sceneEntry = scene.find((a) => a.kind === 'scene');
  const entityCount = Array.isArray(sceneEntry?.payload?.entities) ? sceneEntry!.payload!.entities!.length : 0;
  return entityCount === 0;
}

/** Re-append inline assets that lived in the pack at LOAD but are no longer
 *  reachable from live refs[] (orphans). Mutates `pack.assets` in place.
 *  Pure — no registry; payloads come from the load-time snapshot so we never
 *  depend on an orphan still being resolvable after world edits. */
export function mergeLoadedInlineOrphans(
  pack: Record<string, unknown>,
  orphans: ReadonlyArray<LoadedInlineSnapshot> | null | undefined,
): number {
  if (!orphans || orphans.length === 0) return 0;
  const assets = pack.assets as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(assets)) return 0;

  const already = new Set(
    assets
      .map((a) => (a.guid as string | undefined)?.toLowerCase())
      .filter((g): g is string => !!g),
  );
  let merged = 0;
  for (const entry of orphans) {
    if (!entry?.guid) continue;
    const key = entry.guid.toLowerCase();
    if (already.has(key)) continue;
    // Normalize refs: accept both flat strings and legacy {guid} objects.
    let clonedRefs: string[] = [];
    if (Array.isArray(entry.refs)) {
      clonedRefs = (entry.refs as unknown[]).map((r) =>
        typeof r === 'string' ? r
          : (r && typeof r === 'object' && 'guid' in r) ? String((r as { guid: unknown }).guid)
          : '',
      ).filter((s) => s.length > 0);
    }
    assets.push({
      guid: entry.guid,
      kind: entry.kind,
      // Clone so a later pack mutate cannot corrupt the load-floor snapshot.
      payload: entry.payload === undefined ? undefined : JSON.parse(JSON.stringify(entry.payload)),
      refs: clonedRefs,
      // The canonical serializer emits Pack v2. Keep orphan entries inside the
      // same envelope contract so a save cannot turn a valid pack malformed.
      artifacts: entry.artifacts === undefined ? {} : JSON.parse(JSON.stringify(entry.artifacts)),
    });
    already.add(key);
    merged++;
    console.info(
      `[editor-core][diag]   orphan=${entry.guid} → MERGED from load snapshot (kind=${entry.kind})`,
    );
  }
  if (merged > 0) {
    console.info(
      `[editor-core][diag] mergeLoadedInlineOrphans: merged=${merged}, total assets now=${assets.length} (inline=${assets.filter((a) => a.kind !== 'scene').length})`,
    );
  }
  return merged;
}

/** Re-append inline asset bodies (materials etc. whose payload lives in THIS
 *  scene.pack) to a freshly serialized pack, so saving round-trips them instead
 *  of silently dropping the payload. Mutates `pack.assets` in place. Pure — no
 *  deps (the registry is passed in). */
function appendInlineAssets(
  pack: Record<string, unknown>,
  reg: AssetRegistry,
  sceneGuid: string | undefined,
): void {
  const assets = pack.assets as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(assets)) return;
  const sceneEntry = assets.find((a) => a.kind === 'scene');
  const refs = (sceneEntry?.refs as ReadonlyArray<string> | undefined) ?? [];
  if (refs.length === 0) {
    console.warn('[editor-core][diag] appendInlineAssets: refs[] is empty — no inline assets to append');
    return;
  }

  // The package path that identifies "inline to this scene". Prefer the scene
  // GUID's own package path; fall back to the scene entry's guid.
  const scenePkgGuid = sceneGuid ?? (sceneEntry?.guid as string | undefined);
  const scenePkgPath = scenePkgGuid ? reg.packageOf(scenePkgGuid)?.path : undefined;

  console.info(
    `[editor-core][diag] appendInlineAssets: sceneGuid=${sceneGuid}, scenePkgGuid=${scenePkgGuid}, scenePkgPath=${scenePkgPath}, refs.length=${refs.length}`,
  );

  const already = new Set(assets.map((a) => (a.guid as string | undefined)?.toLowerCase()));
  let appendedCount = 0;

  for (const refGuid of refs) {
    const key = refGuid.toLowerCase();
    if (already.has(key)) {
      console.info(`[editor-core][diag]   ref=${refGuid} → already in pack (skip)`);
      continue;
    }
    const pkg = reg.packageOf(refGuid);
    const payload = reg.lookup(refGuid) as { kind?: string } | undefined;
    if (!payload) {
      console.warn(`[editor-core][diag]   ref=${refGuid} → reg.lookup returned null (unresolvable, skip)`);
      continue;
    }
    // Builtin meshes (packageOf === null, kind mesh) auto-register on load; a
    // catalog asset has its own file (path !== scenePath). Only inline when the
    // asset's body genuinely belongs in this scene.pack:
    //   - same package path as the scene, OR
    //   - no owning package (null) AND not a builtin mesh (editor-authored).
    const isInline =
      (pkg != null && pkg.path === scenePkgPath && payload.kind !== 'scene') ||
      (pkg === null && payload.kind !== 'mesh' && payload.kind !== 'scene');
    if (!isInline) {
      console.info(
        `[editor-core][diag]   ref=${refGuid} → NOT inline (kind=${payload.kind}, pkg.path=${pkg?.path ?? 'null'}, scenePkgPath=${scenePkgPath}) (skip)`,
      );
      continue;
    }
    console.info(`[editor-core][diag]   ref=${refGuid} → INLINE (kind=${payload.kind}, pkg.path=${pkg?.path ?? 'null'}) → appending`);
    const catalogRefs = reg.assetCatalog.get(key)?.refs;
    assets.push({
      guid: refGuid,
      kind: payload.kind,
      payload,
      // The registry envelope can retain the refs that loaded this material.
      // The material normalizer below converts AssetRef objects to wire strings
      // and re-encodes any GUID-valued texture fields into indices.
      refs: Array.isArray(catalogRefs) ? catalogRefs : [],
      artifacts: {},
    });
    already.add(key);
    appendedCount++;
  }

  console.info(
    `[editor-core][diag] appendInlineAssets done: appended=${appendedCount}, total assets now=${assets.length} (scene=1, inline=${assets.length - 1})`,
  );
}

/**
 * Build the high-side-effect disk-io unit. See file header for the full model.
 *
 * State: none at factory scope — all mutable persistence state lives on
 * `deps.ctx` (ScenePersistenceContext); the factory only closes over `deps`.
 */
export function createDiskIo(deps: DiskIoDeps): DiskIo {
  const { ctx, gateway } = deps;

  // ── path helpers ────────────────────────────────────────────────────────────
  /** @internal-store — disk-watch READS this to filter ws events to THIS game's
   *  scene file (D-6 seam). */
  function scenePath(): string | null {
    if (ctx.authoringSession.mode !== 'authored') return null;
    if (ctx.currentSceneId === 'default') return null;
    if (ctx.currentSceneFile) {
      const entry = ctx.sceneList.find((s) => s.id === ctx.currentSceneFile);
      if (entry) return deps.resolveGamePath(entry.pack);
    }
    return deps.resolveGamePath('scene.pack.json');
  }

  /** The scene asset GUID to persist for the active scene. Prefers the GUID we
   *  read from disk (stable identity); for a brand-new scene with no file yet,
   *  derives a STABLE GUID from the scene path (NOT doc.order). */
  function sceneGuidForSave(): string | undefined {
    if (ctx.currentSceneGuid) return ctx.currentSceneGuid;
    const p = scenePath();
    return p ? stableGuid('scene|' + p) : undefined;
  }

  // ── engine-native world -> pack serialization ────────────────────────────────
  /** @internal-store — serializes the live world into the on-disk pack bytes;
   *  used by serializedPack (the save path). disk-watch no longer re-serialises
   *  here: it recognises a self-save echo via ctx.lastSelfSave instead. */
  function worldToPack(doc: EditSession, sceneGuid?: string): string | null {
    const w: WorldType = doc.world;
    const reg: AssetRegistry | undefined = doc.registry;
    if (!w || !reg) {
      console.warn('[editor-core] worldToPack: world or registry missing');
      return null;
    }
    // Collect ALL root entities (visible AND hidden) so hidden entities survive
    // the round-trip (AC-05); only the EditorHidden MARKER is stripped (AC-04).
    // The load path records the exact flat top-level roots in currentSceneEntities.
    // Keep those roots in the save set even when the live Name query cannot see
    // them (e.g. a scene entity with no Name component); the world walk still
    // contributes roots spawned after load.
    const rootHandles: EntityHandle[] = [...new Set<number>([
      ...ctx.currentSceneEntities.map((handle) => handle as number),
      ...(worldRootHandles(w) as number[]),
    ])] as EntityHandle[];
    const assetR = rootsToSceneAsset(reg, w, rootHandles);
    if (!assetR.ok) {
      console.warn('[editor-core] worldToPack: rootsToSceneAsset failed:', assetR.error);
      return null;
    }
    // Strip the editor-only EditorHidden marker from every collected entity — a
    // registered component rootsToSceneAsset would otherwise emit (AC-04). The
    // entity itself stays (AC-05). SceneAsset is readonly → rebuild without it.
    const strippedAsset = stripEditorHiddenMarker(assetR.value) as SceneAsset;
    const packR = serializeSceneAssetToPack(strippedAsset, sceneGuid);
    if (!packR.ok) {
      console.warn('[editor-core] worldToPack: serializeSceneAssetToPack failed:', packR.error);
      return null;
    }
    // Round-trip inline assets (materials etc.) that physically live IN this
    // scene.pack — the engine serializer emits only the scene entry, so dropping
    // an inline body is data loss ("add-to-scene → whole scene turned grey").
    const packObj = packR.value as Record<string, unknown>;
    const preAppendCount = (packObj.assets as Array<unknown>)?.length ?? 0;
    appendInlineAssets(packObj, reg, sceneGuid);
    // Orphans: inline bodies on disk at load that are no longer in live refs[]
    // (e.g. material still in pack, no MeshRenderer holds it). Merge from the
    // load snapshot so save cannot drop authored pack data below the floor.
    const orphanMerged = mergeLoadedInlineOrphans(packObj, ctx.loadedInlineAssets);
    const postAppendCount = (packObj.assets as Array<unknown>)?.length ?? 0;
    const materialRefs = normalizeMaterialPackEntries(packObj);
    if (!materialRefs.ok) {
      console.warn('[editor-core][diag] worldToPack: material refs normalization refused save:', materialRefs.error);
      return null;
    }
    const miRefs = normalizeMaterialInstancePackEntries(packObj);
    if (!miRefs.ok) {
      console.warn('[editor-core][diag] worldToPack: material-instance refs normalization refused save:', miRefs.error);
      return null;
    }
    // The engine collector emits its historical v1 shell. Upgrade only at the
    // editor-owned persistence boundary; the engine runtime remains strict on
    // Pack v2 and does not need a legacy fallback.
    normalizePackForRuntime(packObj);
    console.info(
      `[editor-core][diag] worldToPack: sceneGuid=${sceneGuid}, rootHandles=${rootHandles.length}, assets before append=${preAppendCount}, after=${postAppendCount}, orphanMerged=${orphanMerged}`,
    );
    return JSON.stringify(packObj, null, 2) + '\n';
  }

  /** The exact byte content saveDocToDisk would write for the current doc (used
   *  by the disk watcher to recognise its own echo). Returns null on serialize
   *  FAILURE — callers MUST treat null as "do not write" (the 0-byte clobber
   *  guard, AGENTS.md #2). */
  function serializedPack(): string | null {
    return worldToPack(gateway.doc, sceneGuidForSave());
  }

  // ── scene-load: canonical engine loadByGuid -> instantiateFlat (engine SSOT) ──
  /** Tear down the currently loaded scene before a fresh (re)load. The opened
   *  scene is FLAT (no synthetic wrapper), so teardown despawns each tracked
   *  top-level entity: `despawnScene(e)` drops `e` plus its whole ChildOf subtree
   *  (authored children + any nested SceneInstance anchor + that anchor's
   *  members). A belt-and-suspenders sweep over `worldRootHandles` catches named
   *  top-level entities added between load and reload so a reload can't orphan
   *  anything. No-op when nothing loaded. */
  function teardownCurrentScene(preserve?: ReadonlySet<number>): void {
    const w: WorldType = gateway.doc.world;
    if (w) {
      const seen = new Set<number>();
      for (const e of ctx.currentSceneEntities) {
        if (seen.has(e as number)) continue;
        if (preserve?.has(e as number)) continue;
        seen.add(e as number);
        try { w.despawnScene(e); } catch { /* best-effort */ }
      }
      try {
        for (const h of worldRootHandles(w)) {
          if (seen.has(h as number)) continue;
          if (preserve?.has(h as number)) continue;
          seen.add(h as number);
          try { w.despawnScene(h); } catch { /* best-effort */ }
        }
      } catch { /* best-effort */ }
    }
    ctx.currentSceneEntities = [];
  }

  /** Open the game's scene by GUID via the engine's canonical loadByGuid ->
   *  instantiateFlat pipeline. Opening a scene = editing the scene ITSELF: its
   *  entities materialise FLAT (no synthetic wrapper root, no forced ChildOf), so
   *  the hierarchy is exactly the authored ChildOf. Nested prefabs inside stay as
   *  their own SceneInstance anchors (instantiateFlat keeps the mount path
   *  anchored). Returns true on success. @internal-store — disk-watch CALLS this
   *  to reload (D-6 seam).
   *
   *  LOAD ORDER: resolve the SceneAsset bytes first, then tear down the old
   *  authored tree, then instantiate the replacement. We must not materialise
   *  two scene graphs in the same World and subsequently try to identify the old
   *  one by root handles: nested SceneInstance anchors and their derived members
   *  share ChildOf/Children teardown paths with their wrapper. The former
   *  instantiate-then-teardown order could therefore despawn a freshly-created
   *  mount member, leaving an anchor whose mapping only contained stale handles
   *  (Fox / imported GLB vanished after Save -> reopen).
   *
   *  `loadByGuid` remains before teardown, so a missing/corrupt pack leaves the
   *  current scene intact. Once a valid payload is available, replacement is
   *  deliberately single-tree rather than pseudo-atomic in one World. */
  async function loadSceneByGuid(sceneGuid: string): Promise<boolean> {
    const w: WorldType = gateway.doc.world;
    const reg: AssetRegistry | undefined = gateway.doc.registry;
    if (!w || !reg) return false;
    try {
      const { AssetGuid } = await import('@forgeax/engine-pack/guid');
      const parsed = AssetGuid.parse(sceneGuid);
      if (!parsed.ok) return false;
      // Fetch + parse before touching the current world. A load failure leaves
      // the current scene intact.
      const loadRes = await reg.loadByGuid(parsed.value);
      if (!loadRes.ok) {
        console.warn(`[editor-core] scene asset load failed guid=${sceneGuid}: ${JSON.stringify(loadRes.error)}`);
        return false;
      }
      const sceneAsset = normalizeAndCatalogSceneAsset(reg, sceneGuid, loadRes.value as SceneAsset);
      const sceneHandle = w.allocSharedRef('SceneAsset', sceneAsset);
      // Do not overlap the replacement with the old scene in one World. See the
      // load-order invariant above: teardown after instantiation can delete the
      // new nested SceneInstance members through an old wrapper's subtree.
      teardownCurrentScene();
      const instRes = reg.instantiateFlat(sceneHandle, w);
      if (!instRes.ok) {
        console.warn(`[editor-core] scene instantiateFlat failed guid=${sceneGuid}: ${JSON.stringify(instRes.error)}`);
        return false;
      }
      // Track the scene's top-level entities so a later reload can despawn them.
      ctx.currentSceneEntities = instRes.value;
      return true;
    } catch (error) {
      console.warn(
        `[editor-core] scene load threw guid=${sceneGuid}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * Resolve and instantiate the exact effective imported SceneAsset once, while
   * retaining an immutable clone for effective-base Promote. This avoids trying
   * to reconstruct a pristine base from a later edited live world.
   */
  async function loadImportedScenePreviewState(facts: {
    readonly guid: string;
    readonly sourceKey: string;
    readonly revision: string;
  }): Promise<ImportedPreviewSessionState | null> {
    const w = gateway.doc.world;
    const reg = gateway.doc.registry;
    if (!w || !reg) return null;
    try {
      const { AssetGuid } = await import('@forgeax/engine-pack/guid');
      const parsed = AssetGuid.parse(facts.guid);
      if (!parsed.ok) return null;
      const loaded = await reg.loadByGuid<SceneAsset>(parsed.value);
      if (!loaded.ok || loaded.value.kind !== 'scene') return null;
      const sceneAsset = normalizeAndCatalogSceneAsset(reg, facts.guid, loaded.value);
      const sceneHandle = w.allocSharedRef('SceneAsset', sceneAsset);
      teardownCurrentScene();
      const instantiated = reg.instantiateFlat(sceneHandle, w);
      if (!instantiated.ok) return null;
      ctx.currentSceneEntities = [...instantiated.value];
      return {
        ...facts,
        effectiveScene: structuredClone(sceneAsset),
        world: w,
        registry: reg,
      };
    } catch {
      return null;
    }
  }

  /**
   * Instantiate a scene sub-asset (e.g. an imported GLB's whole-hierarchy scene)
   * into the CURRENTLY-LOADED editor world as a NESTED SceneInstance under
   * `parentHandle`, via the engine's canonical loadByGuid -> allocSharedRef ->
   * instantiate spine — the ANCHORED `reg.instantiate` (keeps a SceneInstance so
   * overrides stay isolated and the prefab source is protected), unlike
   * loadSceneByGuid which opens the top scene FLAT. ADDITIVE: does NOT teardown
   * the current scene / touch currentSceneEntities. Returns the nested root
   * handle, or null on failure — callers MUST treat null as "add failed"
   * (NEVER fall back to a cube).
   */
  async function instantiateSceneRefUnderWorld(
    sceneGuid: string,
    parentHandle: number,
  ): Promise<number | null> {
    const w: WorldType = gateway.doc.world;
    const reg: AssetRegistry | undefined = gateway.doc.registry;
    if (!w || !reg) return null;
    try {
      const { AssetGuid } = await import('@forgeax/engine-pack/guid');
      const parsed = AssetGuid.parse(sceneGuid);
      if (!parsed.ok) return null;
      const loadRes = await reg.loadByGuid(parsed.value);
      if (!loadRes.ok) { console.warn('[editor-core] instantiateSceneRefUnderWorld: loadByGuid failed:', loadRes.error); return null; }
      const sceneAsset = normalizeAndCatalogSceneAsset(reg, sceneGuid, loadRes.value as SceneAsset);
      const sceneHandle = w.allocSharedRef('SceneAsset', sceneAsset);
      const instRes = reg.instantiate(sceneHandle, w, parentHandle as EntityHandle);
      if (!instRes.ok) { console.warn('[editor-core] instantiateSceneRefUnderWorld: instantiate failed:', (instRes.error as { code?: string })?.code); return null; }
      return instRes.value as number;
    } catch (err) {
      console.warn('[editor-core] instantiateSceneRefUnderWorld: threw', err);
      return null;
    }
  }

  /**
   * Resolve a catalogued asset GUID to a LIVE shared<T> handle in the current
   * editor world, via the engine's canonical loadByGuid -> allocSharedRef spine —
   * the SAME spine instantiateSceneRefUnderWorld uses for scenes, generalized to
   * any asset-union type (MaterialAsset / EquirectAsset / AnimationClip / ...).
   * This is the resolution half of the bindAssetRef op: the handle it returns is
   * minted from loadByGuid, so its payload sits in the registry catalog / origin
   * index and engine writeback (_guidForAsset) reverses handle -> GUID on save —
   * the bound ref round-trips (Edit=Play), never a silent handle-0. Returns the
   * u32 handle, or null on a bad GUID / load miss (caller surfaces it; NEVER
   * writes a 0). `assetType` is the engine asset-union tag allocSharedRef expects.
   */
  async function resolveAssetRefToHandle(guid: string, assetType: string): Promise<
    | { ok: true; value: number }
    | { ok: false; error: { code: string; hint: string; detail?: unknown } }
  > {
    const w: WorldType = gateway.doc.world;
    const reg: AssetRegistry | undefined = gateway.doc.registry;
    if (!w || !reg) return { ok: false, error: {
      code: 'asset-registry-unavailable',
      hint: 'The active editor world or asset registry is unavailable.',
    } };
    try {
      const { AssetGuid } = await import('@forgeax/engine-pack/guid');
      const parsed = AssetGuid.parse(guid);
      if (!parsed.ok) return { ok: false, error: {
        code: 'asset-guid-invalid',
        hint: `Asset GUID ${guid} is not a valid RFC 4122 GUID.`,
      } };
      const loadRes = await reg.loadByGuid(parsed.value);
      if (!loadRes.ok) {
        const cause = loadRes.error as { code?: string; hint?: string; detail?: unknown };
        return { ok: false, error: {
          code: cause.code ?? 'asset-load-failed',
          hint: cause.hint ?? `Could not load asset ${guid}.`,
          ...(cause.detail === undefined ? {} : { detail: cause.detail }),
        } };
      }
      // allocSharedRef is chrome handle-casting (mirrors drag-spawn-resolve's mesh/
      // material minting); the resulting handle rides the setComponent the op then
      // dispatches (which DOES go through the ledger). Cast to the u32 the component
      // shared<T> field stores.
      const handle = w.allocSharedRef(assetType as never, loadRes.value) as unknown as number;
      return { ok: true, value: handle };
    } catch (err) {
      return { ok: false, error: {
        code: 'asset-resolution-threw',
        hint: err instanceof Error ? err.message : String(err),
      } };
    }
  }

  // ── disk load ────────────────────────────────────────────────────────────────
  /** Load the active game's scene from disk (native pack). Returns true if a
   *  valid doc was loaded. Uses engine-native world.instantiateScene via
   *  loadSceneByGuid (AC-09). */
  async function doLoadDocFromDisk(): Promise<boolean> {
    const p = scenePath();
    if (!p) return false;
    const reg = gateway.doc.registry;
    // Forget the previous scene's identity before loading a new one.
    ctx.currentSceneGuid = null;
    ctx.loadedInlineAssetFloor = null;
    ctx.loadedInlineAssets = null;
    ctx.loadedEntityFloor = null;
    try {
      const r = await deps.fetchWithTimeout(`/api/files?path=${encodeURIComponent(p)}`);
      if (r.ok) {
        const j = (await r.json()) as { content?: string };
        if (j.content) {
          const parsed = JSON.parse(j.content);
          if (isScenePack(parsed)) {
            // Repair legacy material payloads before the engine reads the scene.
            // This is deliberately persisted through the asset gate so a
            // refresh cannot reintroduce the same malformed refs/metallic shape.
            const materialRefs = normalizeMaterialPackEntries(parsed as unknown as Record<string, unknown>);
            if (!materialRefs.ok) {
              console.error('[editor-core][diag] doLoadDocFromDisk: unsafe material migration refused:', materialRefs.error);
              return false;
            }
            const miRefs = normalizeMaterialInstancePackEntries(parsed as unknown as Record<string, unknown>);
            if (!miRefs.ok) {
              console.error('[editor-core][diag] doLoadDocFromDisk: unsafe material-instance migration refused:', miRefs.error);
              return false;
            }
            if (materialRefs.changed) {
              // Each entry is read-modify-written inside the asset gate. Do not
              // replace the whole stale load snapshot: a concurrent create
              // operation may have appended another authored asset meanwhile.
              for (const entry of materialRefs.changedEntries) {
                const migrated = await assetIO.writePackEntry(p, entry as never);
                if (!migrated) {
                  console.error('[editor-core][diag] doLoadDocFromDisk: material migration could not be persisted');
                  return false;
                }
              }
              console.info(
                `[editor-core][diag] doLoadDocFromDisk: persisted material refs migration for ${materialRefs.changedEntries.length} asset(s)`,
              );
            }
            if (miRefs.changed) {
              for (const entry of miRefs.changedEntries) {
                const migrated = await assetIO.writePackEntry(p, entry as never);
                if (!migrated) {
                  console.error('[editor-core][diag] doLoadDocFromDisk: material-instance migration could not be persisted');
                  return false;
                }
              }
              console.info(
                `[editor-core][diag] doLoadDocFromDisk: persisted material-instance refs migration for ${miRefs.changedEntries.length} asset(s)`,
              );
            }
            if (materialRefs.changed || miRefs.changed) {
              // A refresh can arrive with the old scene/material payloads
              // already ready in the registry. Invalidate the changed entries
              // and the scene root before loadByGuid, otherwise its ready
              // fast-path would bypass the repaired pack bytes.
              for (const entry of materialRefs.changedEntries) {
                if (typeof entry.guid === 'string') reg?.invalidate(entry.guid);
              }
              for (const entry of miRefs.changedEntries) {
                if (typeof entry.guid === 'string') reg?.invalidate(entry.guid);
              }
              const migratedSceneGuid = parsed.assets.find((asset) => asset.kind === 'scene')?.guid;
              if (typeof migratedSceneGuid === 'string') reg?.invalidate(migratedSceneGuid);
            }
            // Capture the inline-asset floor from the pack AS LOADED, so a later
            // save that would drop materials below this is refused (see the guard
            // in doSaveDocToDisk / flushPendingSaveBeacon). Baseline the on-disk
            // truth, not the live world (which may fail to populate handles).
            ctx.loadedInlineAssetFloor = inlineAssetCount(parsed);
            // Capture entity count from disk so saves cannot overwrite a
            // non-empty scene with an empty-entity pack.
            const sceneEntryForFloor = (parsed.assets as Array<{ kind?: string; payload?: { entities?: unknown[] } }>)
              .find((a) => a.kind === 'scene');
            ctx.loadedEntityFloor = Array.isArray(sceneEntryForFloor?.payload?.entities)
              ? sceneEntryForFloor!.payload!.entities!.length
              : 0;
            // Diagnostic: log what we loaded so we can compare against save-time
            const loadedAssets = parsed.assets as Array<{
              guid?: string;
              kind?: string;
              payload?: unknown;
              refs?: unknown[];
              artifacts?: unknown;
            }>;
            const primarySceneGuid = (loadedAssets.find((a) => a.kind === 'scene')?.guid as string | undefined)?.toLowerCase();
            const loadedInline = loadedAssets.filter((a) => {
              if (a.kind !== 'scene') return true;
              return primarySceneGuid !== undefined && a.guid?.toLowerCase() !== primarySceneGuid;
            });
            // Snapshot full bodies for orphan merge on save (not just the count).
            ctx.loadedInlineAssets = loadedInline
              .filter((a): a is { guid: string; kind: string; payload?: unknown; refs?: unknown[]; artifacts?: unknown } =>
                typeof a.guid === 'string' && typeof a.kind === 'string',
              )
              .map((a) => ({
                guid: a.guid,
                kind: a.kind,
                payload: a.payload === undefined ? undefined : JSON.parse(JSON.stringify(a.payload)),
                refs: Array.isArray(a.refs) ? JSON.parse(JSON.stringify(a.refs)) : [],
                artifacts: a.artifacts === undefined ? undefined : JSON.parse(JSON.stringify(a.artifacts)),
              }));
            console.info(
              `[editor-core][diag] doLoadDocFromDisk: loaded pack from ${p}, total assets=${loadedAssets.length}, inline floor=${ctx.loadedInlineAssetFloor}`,
            );
            console.info(
              `[editor-core][diag] doLoadDocFromDisk: inline assets on disk (${loadedInline.length}):\n` +
              loadedInline.map((a, i) => `  [${i}] ${a.guid} (${a.kind})`).join('\n'),
            );
            const sceneAssetEntry = parsed.assets.find((a: { kind?: string; guid?: string }) => a.kind === 'scene') as { guid?: string } | undefined;
            // Load via the engine's canonical loadByGuid -> instantiate path.
            if (sceneAssetEntry?.guid) {
              const ok = await loadSceneByGuid(sceneAssetEntry.guid);
              if (ok) {
                // Publish the identity only after the engine has actually
                // materialised the target scene. A failed load must not leave
                // a new GUID behind and impersonate successful navigation.
                ctx.currentSceneGuid = sceneAssetEntry.guid;
                ctx.isDirty = false;
                deps.notifyDocChanged();
                return true;
              }
            }
            ctx.currentSceneGuid = null;
            // GUID missing or engine load failed → fall through to seed.
          }
        }
      }
    } catch { /* fall through to seed */ }
    // Only engine-native scene packs load; a legacy scene.json is migrated on the
    // next save (packToSession deleted, AC-15).
    return false;
  }

  // ── disk save ─────────────────────────────────────────────────────────────────
  /** Invalidate the shared AssetRegistry cache for the just-saved SCENE so the
   *  next `loadByGuid` re-fetches fresh disk bytes.
   *
   *  Why (bug: ▶ Play loads the PRE-save scene): `doSaveDocToDisk` writes the new
   *  pack to disk, but the registry `gateway.doc.registry` — which is the SAME
   *  object ▶ Play reads through (`ViewportComponent` sets
   *  `gateway.doc.registry = renderer.assets`, and Play's `loadDefaultScene`
   *  calls `renderer.assets.loadByGuid`) — still holds the boot-time payload in
   *  its `assetCatalog` fast path. Without invalidation the next Play returns the
   *  stale cached SceneAsset (old Transform.pos) even though disk is fresh.
   *
   *  Scope = SCENE GUID ONLY (never the inline material/mesh GUIDs):
   *   1) Correctness — only the scene body goes stale. `rootsToSceneAsset`
   *      collects the scene fresh from the live ECS world, so the on-disk scene
   *      differs from the boot-time catalogued SceneAsset. Inline asset bodies
   *      are written via `reg.lookup()` (sourced FROM the catalog), so the
   *      on-disk body already equals the catalogued payload — invalidating them
   *      buys nothing for Play freshness.
   *   2) Safety — invalidating an inline asset ALSO drops the `assetCatalog`
   *      entry the engine's handle→GUID reverse-lookup (`_guidForAsset`, called
   *      by `rootsToSceneAsset`) needs on the NEXT collect. Self-save no longer
   *      reloads the scene, so nothing repopulates that entry and the SECOND
   *      Ctrl+S fails "serialize failed" (SceneCollectAssetGuidUnresolvedError).
   *      See engine feedback 2026-07-28-invalidate-drops-handle-reverse-lookup.
   *
   *  `invalidate` is a no-op for un-catalogued GUIDs. */
  function invalidateSavedScene(parsedPack: unknown): void {
    const reg = gateway.doc.registry as { invalidate?: (guid: string) => void } | undefined;
    if (!reg || typeof reg.invalidate !== 'function') return;
    const assets = (parsedPack as { assets?: Array<{ guid?: unknown; kind?: unknown }> } | null)
      ?.assets;
    const sceneGuid =
      (Array.isArray(assets)
        ? (assets.find((a) => a?.kind === 'scene')?.guid as string | undefined)
        : undefined) ?? ctx.currentSceneGuid;
    if (typeof sceneGuid === 'string' && sceneGuid.length > 0) reg.invalidate(sceneGuid);
  }

  /** Build a stable structured save failure. The safety guards remain ordered
   *  before any canonical write; this only changes observability from boolean to
   *  CommandError fields that callers can branch on. */
  function saveFailure(
    code: CommandError['code'],
    hint: string,
    subjectRef: { readonly kind: string; readonly id: string },
    options: {
      readonly retryable?: boolean;
      readonly recoveryActions?: readonly string[];
      readonly expected?: unknown;
      readonly current?: unknown;
    } = {},
  ): SaveDocToDiskResult {
    return {
      ok: false,
      error: {
        code,
        hint,
        subjectRef,
        retryable: options.retryable ?? false,
        recoveryActions: options.recoveryActions ?? ['save.inspect'],
        ...(options.expected === undefined ? {} : { expected: options.expected }),
        ...(options.current === undefined ? {} : { current: options.current }),
      },
    };
  }

  function saveSubject(path: string | null): { readonly kind: string; readonly id: string } {
    return { kind: 'scene', id: path ?? 'active-scene' };
  }

  /** Write the active game's scene to disk as a native engine scene pack. MANUAL
   *  save (D-7): on success clears dirty only when the accepted authored revision
   *  is still current. Serialize FIRST and bail on failure — never POST an empty
   *  body over a good scene (0-byte data loss). */
  async function doSaveDocToDisk(options: SaveDocToDiskOptions = {}): Promise<SaveDocToDiskResult> {
    if (ctx.authoringSession.mode !== 'authored') {
      return saveFailure(
        'save-rejected-in-imported-preview',
        'Imported scene previews are read-only and have no authored pack target.',
        { kind: 'scene-asset', id: 'imported-preview' },
        { recoveryActions: ['addSceneAssetToScene', 'promoteImportedScene'] },
      );
    }
    const p = scenePath();
    const subjectRef = saveSubject(p);
    if (!p) {
      return saveFailure('save-serialization-failed', 'No active scene path is available for this save.', subjectRef);
    }
    const acceptedRevision = options.acceptedRevision ?? deps.gateway.rev ?? 0;
    let content: string | null;
    try {
      content = deps.serializeForSave === undefined
        ? serializedPack()
        : deps.serializeForSave(gateway.doc, sceneGuidForSave());
    } catch (cause) {
      return saveFailure(
        'save-unexpected-failure',
        `Save serialization effect threw: ${cause instanceof Error ? cause.message : 'unknown error'}.`,
        subjectRef,
        { retryable: true, recoveryActions: ['save.retry'] },
      );
    }
    if (content === null) {
      console.error('[editor-core] saveDocToDisk: serialize failed — aborting write to protect on-disk scene');
      return saveFailure('save-serialization-failed', 'Scene serialization failed; no bytes were written.', subjectRef);
    }

    // Validate pack shell before writing (AC-02 — plan-strategy D-1/D-3).
    let parsedNew: unknown;
    try {
      parsedNew = JSON.parse(content);
      if (!validatePackShell(parsedNew).ok) {
        console.error('[editor-core] saveDocToDisk: pack shell validation failed — aborting write');
        return saveFailure('save-pack-validation-failed', 'Serialized scene pack failed shell validation; no bytes were written.', subjectRef);
      }
    } catch {
      console.error('[editor-core] saveDocToDisk: failed to parse serialized content');
      return saveFailure('save-pack-validation-failed', 'Serialized scene pack is not valid JSON; no bytes were written.', subjectRef);
    }

    // Safety net (charter §9): refuse a write that would DROP inline asset bodies
    // below the LOAD floor — degrade to "save refused, data preserved" (AGENTS.md
    // #2). Guarding against the load floor (not the current on-disk count) means a
    // prior stripping write can't lower the bar (0 >= 0 no longer passes forever).
    if (wouldDropInlineAssets(ctx.loadedInlineAssetFloor, parsedNew)) {
      const newCount = inlineAssetCount(parsedNew);
      console.error(
        `[editor-core] saveDocToDisk: serialized pack has ${newCount} inline asset(s) but the scene loaded with ${ctx.loadedInlineAssetFloor} — aborting write to protect materials`,
      );
      return saveFailure(
        'save-inline-assets-missing',
        'Serialized scene pack would drop inline asset bodies; no bytes were written.',
        subjectRef,
        { expected: { minimum: ctx.loadedInlineAssetFloor }, current: { actual: newCount } },
      );
    }
    // Entity-drop guard: refuse a write that would overwrite a non-empty scene
    // with an empty-entity pack (e.g. after a failed reload left the world empty).
    if (wouldDropAllEntities(ctx.loadedEntityFloor, parsedNew)) {
      console.error(
        `[editor-core] saveDocToDisk: serialized pack has 0 entities but the scene loaded with ${ctx.loadedEntityFloor} — aborting write to protect scene data`,
      );
      return saveFailure(
        'save-entities-missing',
        'Serialized scene pack would drop authored entities; no bytes were written.',
        subjectRef,
        { expected: { minimum: ctx.loadedEntityFloor }, current: { actual: 0 } },
      );
    }

    let canonicalRevision: string | null;
    try {
      canonicalRevision = canonicalScenePackRevision(parsedNew);
    } catch {
      return saveFailure('save-unexpected-failure', 'Could not derive the canonical scene revision.', subjectRef, {
        retryable: true,
        recoveryActions: ['save.retry'],
      });
    }
    if (canonicalRevision === null) {
      return saveFailure('save-pack-validation-failed', 'Could not derive a canonical revision for the validated scene pack.', subjectRef);
    }

    let committedRevision: string;
    try {
      // Serialize against every OTHER pack write on this path that goes through
      // the asset gate (createMaterial's read-modify-write above all): the save
      // body was computed from the world BEFORE this point, so a material write
      // that lands between serialization and this commit would be clobbered by
      // the write below. Entering the gate's per-path chain makes the two
      // writes strictly ordered, and the floor re-check INSIDE the chain turns
      // a lost race into a loud refused-save instead of silent data loss.
      type CommitOutcome =
        | { readonly ok: true; readonly committedRevision: string }
        | { readonly ok: false; readonly saveResult: ReturnType<typeof saveFailure> };
      const outcome = await assetIO.runExclusivePackWrite(p, async (): Promise<CommitOutcome> => {
        // Re-check the inline floor with the CURRENT baseline: a createMaterial
        // that completed while this save waited on the chain bumped the floor,
        // and the pre-computed body would drop it.
        if (wouldDropInlineAssets(ctx.loadedInlineAssetFloor, parsedNew)) {
          return {
            ok: false,
            saveResult: saveFailure(
              'save-inline-assets-missing',
              'Serialized scene pack would drop inline asset bodies written after serialization began; no bytes were written.',
              subjectRef,
              { expected: { minimum: ctx.loadedInlineAssetFloor }, current: { actual: inlineAssetCount(parsedNew) } },
            ),
          };
        }
        const transactionInput = {
          path: p,
          content,
          canonicalRevision,
          changes: [createPackResourceChange(p, content)],
        };
        const preparedResource = deps.prepareResourceTransaction === undefined
          ? await assetIO.prepareResourceTransaction(transactionInput)
          : await deps.prepareResourceTransaction(transactionInput);
        if (preparedResource !== null) {
          const committed = await preparedResource.commit();
          if (committed.revision.length === 0) {
            return {
              ok: false,
              saveResult: saveFailure('save-write-failed', 'Canonical resource transaction did not publish a revision.', subjectRef, {
                retryable: true,
                recoveryActions: ['save.retry'],
              }),
            };
          }
          return { ok: true, committedRevision: committed.revision };
        }
        const response = await deps.fetch('/api/files', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: p, content }),
        });
        if (!response.ok) {
          return {
            ok: false,
            saveResult: saveFailure('save-write-failed', `Scene pack write failed with HTTP ${response.status}.`, subjectRef, {
              retryable: true,
              recoveryActions: ['save.retry'],
              expected: { status: 200 },
              current: { status: response.status },
            }),
          };
        }
        return { ok: true, committedRevision: canonicalRevision };
      });
      if (!outcome.ok) return outcome.saveResult;
      committedRevision = outcome.committedRevision;
    } catch (cause) {
      return saveFailure(
        'save-write-failed',
        `Scene pack canonical commit failed: ${cause instanceof Error ? cause.message : 'unknown error'}.`,
        subjectRef,
        { retryable: true, recoveryActions: ['save.retry'] },
      );
    }

    const currentRevision = deps.gateway.rev ?? acceptedRevision;
    const dirty = currentRevision !== acceptedRevision;
    ctx.isDirty = dirty;
    // Record the exact bytes we wrote so the disk watcher recognises the
    // resulting file-change event as its OWN echo (and does not treat the save as
    // an external edit that forces a full scene reload).
    ctx.setLastSelfSave({ path: p, content, at: Date.now() });
    // Save is the "asset bytes changed" boundary: drop the stale registry cache
    // so the next ▶ Play (loadByGuid) re-reads the scene we just wrote.
    invalidateSavedScene(parsedNew);
    return {
      ok: true,
      result: { path: p, committedRevision, acceptedRevision, currentRevision, dirty },
    };
  }


  // ── unload-time flush ─────────────────────────────────────────────────────────
  /** Flush unsaved edits SYNCHRONOUSLY-SAFE, even as the editor iframe is torn
   *  down (mode switch). navigator.sendBeacon is the one write the browser
   *  guarantees on unload/pagehide. Serialize BEFORE clearing dirty / sending —
   *  a null serialize skips the beacon (protects the on-disk scene). */
  function flushPendingSaveBeacon(): void {
    if (ctx.authoringSession.mode !== 'authored') return;
    if (!ctx.isDirty) return; // nothing dirty
    const p = scenePath();
    if (!p) return;
    const content = serializedPack();
    if (content === null) {
      console.error('[editor-core] flushPendingSaveBeacon: serialize failed — skipping beacon to protect on-disk scene');
      return;
    }
    // Same material-drop guard as doSaveDocToDisk, applied SYNCHRONOUSLY (the beacon
    // fires during pagehide and cannot await a disk read). Without
    // it, an Edit→Play flip or tab-hide could beacon a stripped pack over a good
    // scene — the original hole through which materials were lost. Keep ctx.isDirty
    // set so a later real save can still persist legitimate edits.
    let parsedBeacon: unknown;
    try { parsedBeacon = JSON.parse(content); } catch { parsedBeacon = undefined; }
    if (parsedBeacon !== undefined && wouldDropInlineAssets(ctx.loadedInlineAssetFloor, parsedBeacon)) {
      console.error(
        `[editor-core] flushPendingSaveBeacon: pack has ${inlineAssetCount(parsedBeacon)} inline asset(s) but the scene loaded with ${ctx.loadedInlineAssetFloor} — skipping beacon to protect materials`,
      );
      return; // keep ctx.isDirty; do not clobber the on-disk scene
    }
    if (parsedBeacon !== undefined && wouldDropAllEntities(ctx.loadedEntityFloor, parsedBeacon)) {
      console.error(
        `[editor-core] flushPendingSaveBeacon: pack has 0 entities but the scene loaded with ${ctx.loadedEntityFloor} — skipping beacon to protect scene data`,
      );
      return; // keep ctx.isDirty; do not clobber the on-disk scene
    }
    ctx.isDirty = false;
    // Record the beacon's bytes too so a watcher event it triggers is recognised
    // as a self-save echo rather than an external edit (mirrors doSaveDocToDisk).
    ctx.setLastSelfSave({ path: p, content, at: Date.now() });
    try {
      const blob = new Blob([JSON.stringify({ path: p, content })], { type: 'application/json' });
      const ok = navigator.sendBeacon('/api/files', blob);
      // sendBeacon can refuse (queue full / too large); fall back to a keepalive
      // fetch which also survives teardown for small bodies.
      if (!ok) void deps.fetch('/api/files', { method: 'POST', headers: { 'content-type': 'application/json' }, body: blob, keepalive: true });
    } catch {
      // last resort — best-effort save through the dispatch wrapper (ledger entry
      // preserved, OOS-1) or the raw impl when no wrapper is wired (headless).
      if (deps.saveDocToDiskViaDispatch) deps.saveDocToDiskViaDispatch();
      else void doSaveDocToDisk();
    }
  }

  // ── doc replace ────────────────────────────────────────────────────────────────
  /** Rebuild a fresh EditSession around an incoming {world, registry} so its
   *  `asset` getter stays live after a scene swap. */
  function reviveSession(doc: EditSession): EditSession {
    const fresh = createEditSession();
    fresh.world = doc.world;
    if (doc.registry !== undefined && doc.registry !== null) fresh.registry = doc.registry;
    return fresh;
  }

  /** Replace the entire authored document (scene load/import). Resets selection
   *  and undo history since old inverses no longer apply to the new doc. */
  function replaceDoc(doc: EditSession): void {
    gateway.replaceDoc(reviveSession(doc));
    gateway.dispatch({ kind: 'setSelectionMany', ids: [] });
    deps.notifyDocChanged();
  }

  // Session-op registration (loadDocFromDisk) + the runAsyncOp capture-promise
  // seam live in the composition root (scene-persistence.ts), so the
  // ctx.asyncOpResult slot stays in one place. saveDocToDisk is owned by the
  // OperationRun registry; this factory only produces the raw async impls.
  return {
    scenePath,
    worldToPack,
    stripEditorHiddenMarker,
    inlineAssetCount,
    loadSceneByGuid,
    loadImportedScenePreviewState,
    instantiateSceneRefUnderWorld,
    resolveAssetRefToHandle,
    doLoadDocFromDisk,
    doSaveDocToDisk,
    flushPendingSaveBeacon,
    replaceDoc,
  };
}
