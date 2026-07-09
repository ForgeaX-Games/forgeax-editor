// store/persistence/disk-io — the HIGH SIDE-EFFECT persistence cluster of the
// game's authored scene: disk load / save, engine-native world<->pack
// serialization, canonical loadByGuid -> instantiate scene-load, and the
// unload-time save beacon.
//
// M2 (w6): this is a `createDiskIo(deps)` DI factory (the run-lifecycle
// `create<Thing>(deps)` pattern). Everything that reaches OUTSIDE the module —
// the network (apiFetch / fetchWithTimeout), the live engine world
// (gateway.doc), the host path resolver, and the persistence state handle
// (ScenePersistenceContext) — arrives THROUGH `deps`, so a reader sees the whole
// dependency edge in the factory signature and a headless test injects fakes for
// every one (AC-02). scene-persistence.ts is the composition root: it builds ONE
// createDiskIo with the real gateway / apiFetch / fetchWithTimeout and re-exports
// the resulting functions (barrel surface unchanged, consumers zero-change).
//
// D-3 apiFetch-as-dep (the core R-6 seam): `apiFetch` moved from a module-level
// `import { apiFetch }` to `deps.apiFetch`. This is a STRUCTURAL change (allowed
// by plan-strategy §2 D-3) — the transport body (io/api-client.ts) is untouched
// (OOS-4). The injected value is still `getApiClient().fetch` in production, so
// lint-no-direct-api-fetch stays satisfied — every network read goes through
// deps.apiFetch / deps.fetchWithTimeout, never a raw hardcoded-transport call.
//
// D-8 (fan_in avoidance): this file lives under store/persistence/ and is NOT
// re-exported from the core index.ts top-level barrel — only scene-persistence.ts
// (already in the store barrel) composes + forwards it, so core's index.ts fan_in
// (42) does not rebound (plan-strategy §2 D-8 / R-4).
//
// OOS-1 (zero behavior change): every body here is the verbatim logic previously
// in scene-persistence.ts; the only edits are `apiFetch`/`fetchWithTimeout`/
// `gateway.doc`/`resolveGamePath` reads re-pointed at `deps`. The 0-byte
// data-loss guards (serialize-fail aborts the write; inline-asset preservation
// net) are preserved exactly (AGENTS.md #2).
//
// Anchors:
//   (forward) plan-strategy feat-20260709-editor-large-file-di-decompose-wave2-c-domain-scen
//     plan-id; AC-01/AC-02 (DI factory, headless-injectable, no singleton read) +
//     AC-08 (core max_file_loc drop) + AC-07 (bidirectional anchors);
//     plan-strategy §2 D-3 (apiFetch via deps) + D-8 (subdir landing) + §8 naming
//     (create<Thing> / <Thing>Deps).
//   (backward) extracted from store/scene-persistence.ts (this loop's target),
//     itself split out of store.ts by historical feat
//     feat-20260705-editor-core-engine-convergence-store-ts-decompose.
import { isScenePack, stableGuid, validatePackShell } from '../../scene/scene-pack';
import { rootsToSceneAsset, serializeSceneAssetToPack } from '@forgeax/engine-runtime';
import { createEditSession } from '../../session/document';
import { worldRootHandles } from '../entity-state';
import type { ScenePersistenceContext } from '../scene-persistence';
import type { EditorOp, EditSession } from '../../types';
import type { EntityHandle, WorldType } from '../../scene/scene-types';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { SceneAsset } from '@forgeax/engine-types';

/** The single-pointer gateway surface disk-io needs — a structural mirror of
 *  EditGateway (the same DI shape run-lifecycle's RunGateway uses). Headless
 *  tests supply a fake carrying a null-world doc; production passes the real
 *  gateway singleton. */
export interface PersistenceGateway {
  /** The live authoring document (world + registry). Read on every serialize /
   *  scene-load; null world/registry short-circuits headlessly. */
  readonly doc: EditSession;
  /** Replace the whole authoring document (scene swap). */
  replaceDoc(doc: EditSession): void;
  /** Dispatch a session op (used by replaceDoc to clear selection). */
  dispatch(op: EditorOp): { ok: boolean };
}

/**
 * Everything createDiskIo needs, declared explicitly (Pipeline Isolation). No
 * implicit module globals — the headless test supplies a fake ctx + fake
 * gateway + fake apiFetch / fetchWithTimeout that never touch the network.
 */
export interface DiskIoDeps {
  /** The persistence-state handle (7 formerly-singleton fields). All state reads
   *  and writes go through this — never a module-level `let`. */
  readonly ctx: ScenePersistenceContext;
  /** The gateway (live doc + replaceDoc + dispatch). */
  readonly gateway: PersistenceGateway;
  /** The injected ApiClient fetch (D-3 / R-6). Production = getApiClient().fetch;
   *  headless test = a fake that records calls and never hits the network. */
  readonly apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Timeout-guarded fetch for GET reads (io/net.ts fetchWithTimeout). Injected
   *  so headless tests drive load/echo-compare without a server. */
  readonly fetchWithTimeout: (url: string, ms?: number) => Promise<Response>;
  /** Host path resolver — game-relative name -> absolute /api path. Injected so
   *  a headless test controls it without installing a global resolver. */
  readonly resolveGamePath: (rel: string) => string;
  /** Signal a doc reload to React consumers (doc-version). */
  readonly notifyDocChanged: () => void;
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
  instantiateSceneRefUnderWorld(sceneGuid: string, parentHandle: number): Promise<number | null>;
  doLoadDocFromDisk(): Promise<boolean>;
  doSaveDocToDisk(): Promise<boolean>;
  flushPendingSaveBeacon(): void;
  replaceDoc(doc: EditSession): void;
}

/** Remove the editor-only `EditorHidden` marker from a collected SceneAsset's
 *  entities so it never lands in the persisted pack (AC-04), while the entities
 *  themselves stay (AC-05). SceneAsset/entities are readonly, so rebuild.
 *  Pure — no deps; exported standalone so scene-persistence re-exports it. */
export function stripEditorHiddenMarker(asset: unknown): unknown {
  const a = asset as { kind: string; entities?: ReadonlyArray<{ localId: unknown; components: Record<string, unknown> }> };
  if (!a || !Array.isArray(a.entities)) return asset;
  return {
    ...a,
    entities: a.entities.map((e) => {
      if (!e.components || !('EditorHidden' in e.components)) return e;
      const { EditorHidden: _drop, ...rest } = e.components;
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
  if (refs.length === 0) return;

  // The package path that identifies "inline to this scene". Prefer the scene
  // GUID's own package path; fall back to the scene entry's guid.
  const scenePkgGuid = sceneGuid ?? (sceneEntry?.guid as string | undefined);
  const scenePkgPath = scenePkgGuid ? reg.packageOf(scenePkgGuid)?.path : undefined;

  const already = new Set(assets.map((a) => (a.guid as string | undefined)?.toLowerCase()));

  for (const refGuid of refs) {
    const key = refGuid.toLowerCase();
    if (already.has(key)) continue;
    const pkg = reg.packageOf(refGuid);
    const payload = reg.lookup(refGuid) as { kind?: string } | undefined;
    if (!payload) continue; // unresolvable — leave as a bare ref (catalog/builtin)
    // Builtin meshes (packageOf === null, kind mesh) auto-register on load; a
    // catalog asset has its own file (path !== scenePath). Only inline when the
    // asset's body genuinely belongs in this scene.pack:
    //   - same package path as the scene, OR
    //   - no owning package (null) AND not a builtin mesh (editor-authored).
    const isInline =
      (pkg != null && pkg.path === scenePkgPath) ||
      (pkg === null && payload.kind !== 'mesh' && payload.kind !== 'scene');
    if (!isInline) continue;
    assets.push({ guid: refGuid, kind: payload.kind, payload, refs: [] });
    already.add(key);
  }
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
  /** @internal-store — disk-watch READS this to serialize the live world for the
   *  self-save echo content-compare (D-6 seam). */
  function worldToPack(doc: EditSession, sceneGuid?: string): string | null {
    const w: WorldType = doc.world;
    const reg: AssetRegistry | undefined = doc.registry;
    if (!w || !reg) {
      console.warn('[editor-core] worldToPack: world or registry missing');
      return null;
    }
    // Collect ALL root entities (visible AND hidden) so hidden entities survive
    // the round-trip (AC-05); only the EditorHidden MARKER is stripped (AC-04).
    const rootHandles: EntityHandle[] = worldRootHandles(w);
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
    appendInlineAssets(packR.value as Record<string, unknown>, reg, sceneGuid);
    return JSON.stringify(packR.value, null, 2) + '\n';
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
  function teardownCurrentScene(): void {
    const w: WorldType = gateway.doc.world;
    if (w) {
      const seen = new Set<number>();
      for (const e of ctx.currentSceneEntities) {
        if (seen.has(e as number)) continue;
        seen.add(e as number);
        try { w.despawnScene(e); } catch { /* best-effort */ }
      }
      try {
        for (const h of worldRootHandles(w)) {
          if (seen.has(h as number)) continue;
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
   *  to reload (D-6 seam). */
  async function loadSceneByGuid(sceneGuid: string): Promise<boolean> {
    const w: WorldType = gateway.doc.world;
    const reg: AssetRegistry | undefined = gateway.doc.registry;
    if (!w || !reg) return false;
    try {
      const { AssetGuid } = await import('@forgeax/engine-pack/guid');
      const parsed = AssetGuid.parse(sceneGuid);
      if (!parsed.ok) return false;
      // Clear any previously loaded scene first so a reload doesn't double-spawn.
      teardownCurrentScene();
      const loadRes = await reg.loadByGuid(parsed.value);
      if (!loadRes.ok) return false;
      const sceneHandle = w.allocSharedRef('SceneAsset', loadRes.value);
      const instRes = reg.instantiateFlat(sceneHandle, w);
      if (!instRes.ok) return false;
      // Track the scene's top-level entities so a later reload can despawn them.
      ctx.currentSceneEntities = instRes.value;
      return true;
    } catch {
      return false;
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
      const sceneHandle = w.allocSharedRef('SceneAsset', loadRes.value);
      const instRes = reg.instantiate(sceneHandle, w, parentHandle as EntityHandle);
      if (!instRes.ok) { console.warn('[editor-core] instantiateSceneRefUnderWorld: instantiate failed:', (instRes.error as { code?: string })?.code); return null; }
      return instRes.value as number;
    } catch (err) {
      console.warn('[editor-core] instantiateSceneRefUnderWorld: threw', err);
      return null;
    }
  }

  // ── disk load ────────────────────────────────────────────────────────────────
  /** Load the active game's scene from disk (native pack). Returns true if a
   *  valid doc was loaded. Uses engine-native world.instantiateScene via
   *  loadSceneByGuid (AC-09). */
  async function doLoadDocFromDisk(): Promise<boolean> {
    const p = scenePath();
    if (!p) return false;
    // Forget the previous scene's identity before loading a new one.
    ctx.currentSceneGuid = null;
    try {
      const r = await deps.fetchWithTimeout(`/api/files?path=${encodeURIComponent(p)}`);
      if (r.ok) {
        const j = (await r.json()) as { content?: string };
        if (j.content) {
          const parsed = JSON.parse(j.content);
          if (isScenePack(parsed)) {
            // Capture the inline-asset floor from the pack AS LOADED, so a later
            // save that would drop materials below this is refused (see the guard
            // in doSaveDocToDisk / flushPendingSaveBeacon). Baseline the on-disk
            // truth, not the live world (which may fail to populate handles).
            ctx.loadedInlineAssetFloor = inlineAssetCount(parsed);
            const sceneAssetEntry = parsed.assets.find((a: { kind?: string; guid?: string }) => a.kind === 'scene') as { guid?: string } | undefined;
            if (sceneAssetEntry?.guid) ctx.currentSceneGuid = sceneAssetEntry.guid;
            // Load via the engine's canonical loadByGuid -> instantiate path.
            if (sceneAssetEntry?.guid) {
              const ok = await loadSceneByGuid(sceneAssetEntry.guid);
              if (ok) {
                deps.notifyDocChanged();
                return true;
              }
            }
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
  /** Write the active game's scene to disk as a native engine scene pack. MANUAL
   *  save (D-7): on success clears the dirty flag. Serialize FIRST and bail on
   *  failure — never POST an empty body over a good scene (0-byte data loss). */
  async function doSaveDocToDisk(): Promise<boolean> {
    const p = scenePath();
    if (!p) return false;
    const content = serializedPack();
    if (content === null) {
      console.error('[editor-core] saveDocToDisk: serialize failed — aborting write to protect on-disk scene');
      return false;
    }
    // Validate pack shell before writing (AC-02 — plan-strategy D-1/D-3).
    let parsedNew: unknown;
    try {
      parsedNew = JSON.parse(content);
      if (!validatePackShell(parsedNew).ok) {
        console.error('[editor-core] saveDocToDisk: pack shell validation failed — aborting write');
        return false;
      }
    } catch {
      console.error('[editor-core] saveDocToDisk: failed to parse serialized content');
      return false;
    }
    // Safety net (charter §9): refuse a write that would DROP inline asset bodies
    // below the LOAD floor — degrade to "save refused, data preserved" (AGENTS.md
    // #2). Guarding against the load floor (not the current on-disk count) means a
    // prior stripping write can't lower the bar (0 >= 0 no longer passes forever).
    if (wouldDropInlineAssets(ctx.loadedInlineAssetFloor, parsedNew)) {
      console.error(
        `[editor-core] saveDocToDisk: serialized pack has ${inlineAssetCount(parsedNew)} inline asset(s) but the scene loaded with ${ctx.loadedInlineAssetFloor} — aborting write to protect materials`,
      );
      return false;
    }
    try {
      const r = await deps.apiFetch('/api/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: p, content }),
      });
      if (r.ok) ctx.isDirty = false;
      return r.ok;
    } catch {
      return false;
    }
  }


  // ── unload-time flush ─────────────────────────────────────────────────────────
  /** Flush unsaved edits SYNCHRONOUSLY-SAFE, even as the editor iframe is torn
   *  down (mode switch). navigator.sendBeacon is the one write the browser
   *  guarantees on unload/pagehide. Serialize BEFORE clearing dirty / sending —
   *  a null serialize skips the beacon (protects the on-disk scene). */
  function flushPendingSaveBeacon(): void {
    if (!ctx.isDirty) return; // nothing dirty
    const p = scenePath();
    if (!p) return;
    const content = serializedPack();
    if (content === null) {
      console.error('[editor-core] flushPendingSaveBeacon: serialize failed — skipping beacon to protect on-disk scene');
      return;
    }
    // Same material-drop guard as doSaveDocToDisk, applied SYNCHRONOUSLY (the beacon
    // fires during pagehide/VAG_EDITOR_FLUSH and cannot await a disk read). Without
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
    ctx.isDirty = false;
    try {
      const blob = new Blob([JSON.stringify({ path: p, content })], { type: 'application/json' });
      const ok = navigator.sendBeacon('/api/files', blob);
      // sendBeacon can refuse (queue full / too large); fall back to a keepalive
      // fetch which also survives teardown for small bodies.
      if (!ok) void deps.apiFetch('/api/files', { method: 'POST', headers: { 'content-type': 'application/json' }, body: blob, keepalive: true });
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

  // Session-op registration (loadDocFromDisk / saveDocToDisk) + the runAsyncOp
  // capture-promise seam live in the composition root (scene-persistence.ts), so
  // the ctx.asyncOpResult slot stays in one place; this factory only produces the
  // raw async impls (doLoadDocFromDisk / doSaveDocToDisk) it wires there.
  return {
    scenePath,
    worldToPack,
    stripEditorHiddenMarker,
    inlineAssetCount,
    loadSceneByGuid,
    instantiateSceneRefUnderWorld,
    doLoadDocFromDisk,
    doSaveDocToDisk,
    flushPendingSaveBeacon,
    replaceDoc,
  };
}
