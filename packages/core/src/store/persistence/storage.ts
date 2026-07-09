// store/persistence/storage — the localStorage-facing persistence cluster: the
// per-game/scene doc-key derivation, the editor-only hidden-entity sidecar key,
// and the (retired) localStorage doc mirror.
//
// M2 (w7): a `createStorage(deps)` DI factory. Its only dependency edge is the
// persistence-state handle (deps.ctx) — every key is derived from ctx state, so a
// headless test injects a fresh fake ctx and fully controls the derived keys
// (AC-02). localStorage itself is touched behind try/catch (the historical
// behavior for non-browser / storage-unavailable envs), so a bun test that has no
// localStorage still exercises the pure key-derivation logic without throwing.
//
// D-8 (fan_in avoidance): lands under store/persistence/ and is NOT re-exported
// from the core index.ts top-level barrel — only scene-persistence.ts (already in
// the store barrel) composes + forwards it (plan-strategy §2 D-8 / R-4).
//
// OOS-1 (zero behavior change): docKey / buildHiddenKey / clearDocStorage /
// loadDocFromStorage are verbatim from scene-persistence.ts; the only edit is ctx
// reads re-pointed at deps.ctx.
//
// Anchors:
//   (forward) plan-strategy feat-20260709-editor-large-file-di-decompose-wave2-c-domain-scen
//     plan-id; AC-02 (headless-injectable DI unit, no singleton read) + AC-07;
//     plan-strategy §7 M2 (storage cluster split) + §2 D-4 (hidden sidecar) + D-8.
//   (backward) extracted from store/scene-persistence.ts (this loop's target),
//     itself split out of store.ts by historical feat
//     feat-20260705-editor-core-engine-convergence-store-ts-decompose.
import type { ScenePersistenceContext } from '../scene-persistence';

/** All createStorage needs: the persistence-state handle. Keys derive from ctx. */
export interface StorageDeps {
  readonly ctx: ScenePersistenceContext;
}

/** The localStorage-facing surface. */
export interface Storage {
  loadDocFromStorage(): boolean;
  buildHiddenKey(sceneId?: string, sceneFile?: string | null): string;
  clearDocStorage(): void;
}

// Keyed by the scene slug from `?scene=<slug>` (the active game). `setSceneId`
// must run at boot BEFORE loadDocFromStorage.
const DOC_KEY_PREFIX = 'forgeax:editor:doc:v1';
// Hidden entities are editor view-layer state (OOS-6); hidden ids live in
// localStorage sidecar keys, following the same {sceneId}:{sceneFile} scoping
// convention as docKey() (plan-strategy §2 D-4).
const HIDDEN_SIDECAR_KEY_PREFIX = 'forgeax:editor:hidden:v1';

export function createStorage(deps: StorageDeps): Storage {
  const { ctx } = deps;

  function docKey(id: string): string {
    return `${DOC_KEY_PREFIX}:${id}${ctx.currentSceneFile ? `:${ctx.currentSceneFile}` : ''}`;
  }

  function buildHiddenKey(sceneId?: string, sceneFile?: string | null): string {
    const sid = sceneId || ctx.currentSceneId;
    const sfile = sceneFile !== undefined ? sceneFile : ctx.currentSceneFile;
    return sfile
      ? `${HIDDEN_SIDECAR_KEY_PREFIX}:${sid}:${sfile}`
      : `${HIDDEN_SIDECAR_KEY_PREFIX}:${sid}`;
  }

  function loadDocFromStorage(): boolean {
    // feat-20260701-editor-world-container-doc-ecs-collapse M7 / AC-15: the legacy
    // localStorage doc-mirror can no longer rehydrate into a live World; scene
    // state reloads exclusively from the on-disk pack (loadDocFromDisk). Retired.
    return false;
  }

  function clearDocStorage(): void {
    try {
      localStorage.removeItem(docKey(ctx.currentSceneId));
    } catch {
      /* noop */
    }
  }

  return { loadDocFromStorage, buildHiddenKey, clearDocStorage };
}
