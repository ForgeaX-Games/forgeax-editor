// Workbench list + per-workbench dockview layout persistence.
// Primary storage: localStorage for fast sync reads; server-side JSON files
// (.forgeax/prefs/workbenches/<id>.json) as durable fallback.
//
// 2026-07-07 (T7): storage keys are now project-scoped under
// `forgeax:project:${projId}:*`. Runtime reads/writes use the current project
// id (`setCurrentProject(projId)` sets it, `getCurrentProject()` reads it).
// The v7→v8 migration (migrateWorkbenchSchema) inlines old global keys into
// the current project's namespace and rewrites deprecated ids on the fly.
import type { SerializedDockview } from 'dockview';
import type { DockRegion } from '../components/DockShell/regions';
import {
  STORAGE_KEYS,
  workbenchesKeyForProject,
  workbenchLayoutKeyForProject,
  workbenchSchemaVersionKey,
  legacyPanelLocationsKey,
} from './storageKeys';

export interface Workbench {
  id: string;
  name: string;
  /** Optional Lucide icon name for the switcher pill. Unused until Phase 3.5 UI. */
  icon?: string;
  /** True for the two built-in workbenches ('scene' | 'ai'). Prevents delete. */
  isBuiltin: boolean;
  /** For user-duplicated workbenches: which built-in they were derived from. */
  baselineOf?: 'scene' | 'ai';
  /** Saved dockview grid. Null → BUILTIN_WORKBENCHES[id].seed() runs. Populated
   *  server-side; localStorage still caches per-workbench layout under
   *  `forgeax:project:${projId}:workbench-layout:${id}` (v8) for fast sync
   *  reads on next boot. */
  layout: SerializedDockview | null;
  /** Panel → region overrides. Was global useLayoutStore.panelLocations; now
   *  per-workbench. Persisted as part of the Workbench record. */
  panelLocations: Record<string, DockRegion>;
}

// Built-in default-layout schema version. BUMP THIS whenever buildDefault()
// in DockRegion.tsx changes the arrangement of a built-in workbench. On the
// next load, migrateWorkbenchSchema() discards every saved layout whose stamp
// is older, so existing users automatically pick up the new default WITHOUT
// having to hit "重置布局" manually.
//
// Version 3: 2026-06 — evict layouts saved while editor iframes fell back to
//   the outer Studio shell, causing nested workspaces.
// Version 4: 2026-06 — Info panel defaults into the bottom History/Timeline/
//   Capabilities group instead of floating top-right.
// Version 5: 2026-06 — add the Mesh panel as a tab in the top-right
//   Inspector/Material group (registered but never seeded).
// Version 7: 2026-07-07 — evict layouts polluted by T5 reactive effect that
//   dumped every descriptor panel into the workbench workspace on mount.
// Version 8: 2026-07-07 (T7) — project-scoped keys; rewrite legacy ids
//   'workbench' → 'ai' (mode id) and 'workbench' → 'tools' (panel id) inside
//   every saved layout; inline global `forgeax:panel-locations` into each
//   Workbench.panelLocations.
// Version 9: 2026-07-08 — rename built-in Scene workbench id 'edit' → 'scene'
//   (align id with user-visible name; the leftover 'edit' verb is retired).
//   Rewrites Workbench.id, activeId, baselineOf, and the per-workbench layout
//   storage key under every project namespace.
// Version 10: 2026-07-10 — editor panel registration and Scene layout became
//   host-injected; discard cached layouts so dead ep:* panel ids cannot survive.
export const CURRENT_WORKBENCH_SCHEMA_VERSION = 10;

// Core workspace IDs — always present, cannot be deleted.
// 2026-06-30: 'preview'/'play' removed; 'edit' retained as 2x2 viewport workspace.
// 2026-07-07 (T3): AI workbench id renamed 'workbench' → 'ai'.
// 2026-07-07 (T4): AI workbench tools-rail panel id renamed 'workbench' → 'tools'.
// 2026-07-08 (v9): Scene workbench id renamed 'edit' → 'scene' (id/name align).
export const BUILTIN_WORKBENCH_IDS = new Set(['scene', 'ai']);

// Retired workspace IDs — folded into 'scene' by the 2x2 redesign ('scene' now
// hosts the run x display viewport). Old persisted state may still carry these
// as entries; they must be DROPPED on migration (not kept as "custom" tabs),
// else stale 'play'/'preview'/'viewport' tabs resurface alongside 'scene'.
// (AC-02 one-shot migration.)
export const RETIRED_WORKBENCH_IDS = new Set(['play', 'preview', 'viewport']);

export const DEFAULT_WORKBENCHES: Workbench[] = [
  { id: 'scene', name: 'Scene', isBuiltin: true, layout: null, panelLocations: {} },
  { id: 'ai',    name: 'AI',    isBuiltin: true, layout: null, panelLocations: {} },
];

export interface WorkbenchListState { list: Workbench[]; activeId: string }

// ── Project id cache (T7) ─────────────────────────────────────────────────
//
// Every localStorage read/write below routes through `currentProjectId`. The
// default is `'default'` so pre-mount reads (e.g., bootAppMode) still resolve
// deterministically; ProjectSwitcher.tsx calls setCurrentProject(current) as
// soon as /api/projects returns, at which point subscribers re-read via the
// notify() below.
let currentProjectId: string = 'default';

let listeners: Array<() => void> = [];
// Cached snapshot returned by getWorkbenchListSnapshot() — kept stable between
// notify() calls so React's useSyncExternalStore doesn't see a new object on
// every render. Every mutation path funnels through notify(), which clears
// this. Without the cache, loadWorkbenchList's fresh object per call triggers
// "getSnapshot should be cached" warnings and infinite update loops.
let cachedSnapshot: WorkbenchListState | null = null;
function notify(): void {
  cachedSnapshot = null;
  listeners.forEach((fn) => fn());
}

/** Stable-reference snapshot for React useSyncExternalStore consumers. Returns
 *  the same object between mutations; invalidated whenever notify() fires. */
export function getWorkbenchListSnapshot(): WorkbenchListState {
  if (cachedSnapshot) return cachedSnapshot;
  cachedSnapshot = loadWorkbenchList();
  return cachedSnapshot;
}

export function subscribeWorkbenchList(fn: () => void): () => void {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

/**
 * Set the active project id. Idempotent for the same id. On change:
 *   1. runs migrateWorkbenchSchema() (idempotent — no-op past v8)
 *   2. transfers any state stranded under the 'default' fallback id to the
 *      real project id — this fixes a boot-order race where DockRegion.onReady
 *      runs migrateWorkbenchSchema() BEFORE ProjectSwitcher.reload() resolves
 *      /api/projects, so migration writes v8 keys under 'default:*' while the
 *      real project id arrives later. Without this transfer, existing v7 users
 *      on a non-default project silently lose their layout / panelLocations on
 *      the upgrade because the migrated state is stranded under 'default'.
 *   3. notifies subscribers so useSyncExternalStore consumers re-read
 *      against the new project's keys
 */
export function setCurrentProject(projId: string): void {
  if (!projId || projId === currentProjectId) return;
  const oldProjId = currentProjectId;
  currentProjectId = projId;
  migrateWorkbenchSchema(); // idempotent
  // If migration ran under 'default' before the real project id was known,
  // transfer that state to the correct project scope on first switch.
  if (oldProjId === 'default' && projId !== 'default') {
    transferDefaultToProject(projId);
  }
  notify();
}

/**
 * One-shot transfer: if state migrated under the fallback 'default' id
 * (because setCurrentProject hadn't been called yet), move it to the real
 * project id on the first setCurrentProject('real-id') call. Idempotent:
 * never overwrites target keys; safe to call repeatedly. If the target
 * project already has state (from a prior user session), that state wins and
 * the stray 'default:*' keys are simply deleted (source cleared).
 */
function transferDefaultToProject(newProjId: string): void {
  if (newProjId === 'default') return;
  try {
    // 1. Workbench list.
    const defaultListKey = workbenchesKeyForProject('default');
    const targetListKey = workbenchesKeyForProject(newProjId);
    const defaultList = localStorage.getItem(defaultListKey);
    if (defaultList !== null) {
      if (localStorage.getItem(targetListKey) === null) {
        localStorage.setItem(targetListKey, defaultList);
      }
      localStorage.removeItem(defaultListKey);
    }
    // 2. Per-workbench layouts.
    const defaultLayoutPrefix = `forgeax:project:default:workbench-layout:`;
    const targetLayoutPrefix = `forgeax:project:${newProjId}:workbench-layout:`;
    const toMove: Array<[string, string]> = []; // [oldKey, newKey]
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(defaultLayoutPrefix)) continue;
      const suffix = k.slice(defaultLayoutPrefix.length);
      toMove.push([k, `${targetLayoutPrefix}${suffix}`]);
    }
    for (const [oldKey, newKey] of toMove) {
      const value = localStorage.getItem(oldKey);
      if (value !== null && localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, value);
      }
      localStorage.removeItem(oldKey);
    }
  } catch (e) {
    console.error('[workbench] default→project transfer failed:', e);
  }
}

export function getCurrentProject(): string {
  return currentProjectId;
}

/**
 * @internal Test-only. Resets the module-level `currentProjectId` back to its
 * initial `'default'` value so tests exercising the boot-order path can be
 * isolated from earlier tests that already called setCurrentProject().
 * Never call this from production code.
 */
export function __resetCurrentProjectIdForTests(): void {
  currentProjectId = 'default';
}

// ── Migration (v7 → v8) ───────────────────────────────────────────────────

function anyKeyStartsWith(prefix: string): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix)) return true;
    }
  } catch { /* storage unavailable */ }
  return false;
}

/**
 * Rewrite every occurrence of an oldId to newId inside a SerializedDockview.
 * Covers layout.panels (keyed dict + inner id + component field) and every
 * leaf in layout.grid.root (recursive), plus floatingGroups and popoutGroups
 * where dockview may serialize orphan panels.
 */
function rewritePanelId(layout: unknown, oldId: string, newId: string): void {
  if (!layout || typeof layout !== 'object') return;
  const layoutObj = layout as {
    panels?: Record<string, { id?: string; component?: string } | undefined>;
    grid?: { root?: unknown };
    floatingGroups?: unknown[];
    popoutGroups?: unknown[];
  };

  if (layoutObj.panels && typeof layoutObj.panels === 'object') {
    const panels = layoutObj.panels;
    if (panels[oldId]) {
      panels[newId] = { ...panels[oldId], id: newId };
      delete panels[oldId];
    }
    for (const key of Object.keys(panels)) {
      const p = panels[key];
      if (p?.component === oldId) p.component = newId;
    }
  }

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; data?: unknown };
    if (n.type === 'leaf') {
      const d = n.data as { views?: string[]; activeView?: string; referencePanel?: string } | undefined;
      if (Array.isArray(d?.views)) {
        d.views = d.views.map((v) => (v === oldId ? newId : v));
      }
      if (d?.activeView === oldId) d.activeView = newId;
      if (d?.referencePanel === oldId) d.referencePanel = newId;
    }
    if (n.type === 'branch' && Array.isArray(n.data)) {
      (n.data as unknown[]).forEach(walk);
    }
  };
  walk(layoutObj.grid?.root);
  if (Array.isArray(layoutObj.floatingGroups)) layoutObj.floatingGroups.forEach(walk);
  if (Array.isArray(layoutObj.popoutGroups)) layoutObj.popoutGroups.forEach(walk);
}

/**
 * v7 → v8 → v9 → v10 workbench schema migration. Idempotent — the version
 * stamp is written LAST so any thrown error mid-flight causes the next boot to retry.
 *
 * v8 (2026-07-07): read legacy global keys (STORAGE_KEYS.workspaces,
 *   wsLayoutPrefix keys, panel-locations), rewrite deprecated ids
 *   (`workbench` → `ai` for the workbench, `workbench` → `tools` for the
 *   tools-rail panel), inline the orphan panel-locations map into every
 *   Workbench.panelLocations, and write new project-scoped keys.
 *
 * v9 (2026-07-08): rename built-in Scene workbench id 'edit' → 'scene'
 *   (Workbench.id, activeId, baselineOf, per-workbench layout key). Runs on
 *   every project scope discovered in localStorage so an existing user with
 *   state under real project ids doesn't lose their layout.
 *
 * Note: `currentProjectId` defaults to `'default'`. Callers that know the
 * actual project id (ProjectSwitcher) should call setCurrentProject() first —
 * this function is also invoked from within setCurrentProject to catch that
 * case, plus from loadWorkbenchList/loadWorkbenchLayout as belt+suspenders.
 */
export function migrateWorkbenchSchema(): void {
  try {
    // Prefer the new v9 stamp; fall back to legacy stamp for pre-migration users.
    const stored = Number(
      localStorage.getItem(workbenchSchemaVersionKey)
        ?? localStorage.getItem(STORAGE_KEYS.wsLayoutVersion)
        ?? '0',
    );
    if (stored >= CURRENT_WORKBENCH_SCHEMA_VERSION) return;

    // ── v7 → v8 ────────────────────────────────────────────────────────────
    if (stored < 8) migrateV7toV8();

    // ── v8 → v9 ────────────────────────────────────────────────────────────
    // Runs unconditionally when stored < 9 (both after a v7→v8 catch-up and
    // for users who were previously stamped at v8).
    migrateV8toV9();

    // ── v9 → v10 ───────────────────────────────────────────────────────────
    // Scene's layout ownership moved from interface to the editor host. Evict
    // cached Scene layouts so the host can reseed its authoritative layout.
    if (stored < 10) migrateV9toV10();

    // Stamp version LAST — if any step above throws, migration re-runs
    // on next boot.
    localStorage.setItem(workbenchSchemaVersionKey, String(CURRENT_WORKBENCH_SCHEMA_VERSION));
  } catch (e) {
    console.error('[workbench] schema migration failed:', e);
  }
}

// ── v7 → v8 body (extracted so the versioned migrator can call it) ──────────

function migrateV7toV8(): void {
  const projId = currentProjectId;

  // First-run detection: if no legacy state exists at all, just return.
  // (The v9 step below is idempotent on empty stores, and the version stamp
  // is written by the top-level orchestrator.)
  const hasLegacyState =
    localStorage.getItem(STORAGE_KEYS.workspaces) !== null
    || localStorage.getItem(STORAGE_KEYS.workspacesLegacyV1) !== null
    || localStorage.getItem(STORAGE_KEYS.legacyDockLayout) !== null
    || localStorage.getItem(legacyPanelLocationsKey) !== null
    || anyKeyStartsWith(STORAGE_KEYS.wsLayoutPrefix);
  if (!hasLegacyState) return;

  // 1. Read old global state (v2 shape).
  let oldState: { list?: Array<Partial<Workbench> & { id?: string; name?: string }>; activeId?: string } | null = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.workspaces);
    if (raw) oldState = JSON.parse(raw);
  } catch { /* corrupt — fall through to defaults */ }

  // v1 shape has the same skeleton; only used if v2 wasn't there.
  if (!oldState) {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.workspacesLegacyV1);
      if (raw) oldState = JSON.parse(raw);
    } catch { /* noop */ }
  }

  // 2. Read the orphan global panel-locations map (T6 stopped writing it
  // but existing users still have it on disk).
  const oldPanelLocations: Record<string, DockRegion> = (() => {
    try {
      const raw = localStorage.getItem(legacyPanelLocationsKey);
      return raw ? (JSON.parse(raw) as Record<string, DockRegion>) : {};
    } catch { return {}; }
  })();

  // 3. Rewrite list ids: 'workbench' → 'ai'. Merge orphan panel-locations
  // into every entry (existing per-workbench values win). Note: v9 later
  // rewrites 'edit' → 'scene'; here we keep the pre-v9 shape for clarity.
  const rawList = Array.isArray(oldState?.list) && oldState.list.length > 0
    ? oldState.list
    : [
        { id: 'edit', name: 'Edit', isBuiltin: true, layout: null, panelLocations: {} } as Workbench,
        { id: 'ai',   name: 'AI',   isBuiltin: true, layout: null, panelLocations: {} } as Workbench,
      ];
  const mapped: Workbench[] = rawList.map((entry) => {
    const oldId = String(entry.id ?? '');
    const newId = oldId === 'workbench' ? 'ai' : oldId;
    return normaliseEntry({
      ...entry,
      id: newId,
      name: entry.name ?? newId,
      panelLocations: { ...oldPanelLocations, ...(entry.panelLocations ?? {}) },
    } as Workbench);
  });
  // Normalise-as-v8: pre-v9 built-ins are 'edit' + 'ai'. v9 rewrites below.
  const finalList = normaliseListForV8(mapped);

  // 4. Rewrite activeId: 'workbench' → 'ai'; keep only if it's in the list.
  let activeId = oldState?.activeId === 'workbench' ? 'ai' : (oldState?.activeId ?? 'edit');
  if (!finalList.find((w) => w.id === activeId)) activeId = 'edit';

  // 5. Migrate per-workbench layouts. For each workbench in the final list,
  // read the legacy key (using the OLD id — 'workbench' for 'ai'), rewrite
  // panel-id 'workbench' → 'tools' inside the AI workbench's layout, and
  // write to the new project-scoped key.
  for (const wb of finalList) {
    const oldWbId = wb.id === 'ai' ? 'workbench' : wb.id;
    const raw = localStorage.getItem(`${STORAGE_KEYS.wsLayoutPrefix}${oldWbId}`);
    if (!raw) continue;
    try {
      const layout = JSON.parse(raw) as unknown;
      if (wb.id === 'ai') rewritePanelId(layout, 'workbench', 'tools');
      localStorage.setItem(
        workbenchLayoutKeyForProject(projId, wb.id),
        JSON.stringify(layout),
      );
    } catch { /* corrupt — skip; buildDefault will kick in */ }
  }

  // 6. Write the new state under the project-scoped key.
  localStorage.setItem(
    workbenchesKeyForProject(projId),
    JSON.stringify({ list: finalList, activeId }),
  );

  // 7. Delete every old key. Enumerate wsLayoutPrefix keys first so we don't
  // mutate the store while iterating.
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(STORAGE_KEYS.wsLayoutPrefix)) toRemove.push(k);
  }
  toRemove.forEach((k) => localStorage.removeItem(k));
  localStorage.removeItem(STORAGE_KEYS.workspaces);
  localStorage.removeItem(STORAGE_KEYS.workspacesLegacyV1);
  localStorage.removeItem(STORAGE_KEYS.workspaceActiveLegacy);
  localStorage.removeItem(STORAGE_KEYS.legacyDockLayout);
  localStorage.removeItem(legacyPanelLocationsKey);
  localStorage.removeItem(STORAGE_KEYS.wsLayoutVersion);
}

// v8-shape normaliser (pre-'edit' → 'scene' rename). Used only by the v7→v8
// step so its intermediate output round-trips through the v9 rewrite.
function normaliseListForV8(list: Workbench[]): Workbench[] {
  const V8_BUILTINS = new Set(['edit', 'ai']);
  const V8_DEFAULTS: Workbench[] = [
    { id: 'edit', name: 'Edit', isBuiltin: true, layout: null, panelLocations: {} },
    { id: 'ai',   name: 'AI',   isBuiltin: true, layout: null, panelLocations: {} },
  ];
  const customs = list
    .filter((w) => !V8_BUILTINS.has(w.id) && !RETIRED_WORKBENCH_IDS.has(w.id) && w.id !== 'workbench')
    .map((w) => normaliseEntry(w));

  const persistedById = new Map(list.map((w) => [w.id, w]));
  const builtins = V8_DEFAULTS.map((def) => {
    const found = persistedById.get(def.id);
    if (!found) return def;
    const norm = normaliseEntry({ ...found, id: def.id, name: def.name });
    return { ...norm, name: def.name };
  });
  return [...builtins, ...customs];
}

// ── v8 → v9 body ────────────────────────────────────────────────────────────
// Rename built-in Scene workbench id 'edit' → 'scene' across every project
// namespace found in localStorage. Runs after v7→v8 (which writes 'edit'-style
// entries) as well as for users who were already stamped at v8.

function migrateV8toV9(): void {
  try {
    // 1. Find every project's workbenches key: `forgeax:project:<projId>:workbenches`.
    const projectKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith('forgeax:project:') && k.endsWith(':workbenches')) {
        projectKeys.push(k);
      }
    }
    for (const listKey of projectKeys) {
      const raw = localStorage.getItem(listKey);
      if (!raw) continue;
      let state: WorkbenchListState;
      try {
        state = JSON.parse(raw) as WorkbenchListState;
      } catch { continue; }

      let dirty = false;
      if (Array.isArray(state.list)) {
        state.list = state.list.map((w) => {
          if (w.id === 'edit') {
            dirty = true;
            return { ...w, id: 'scene', name: w.name === 'Edit' ? 'Scene' : w.name };
          }
          if (w.baselineOf === ('edit' as unknown)) {
            dirty = true;
            return { ...w, baselineOf: 'scene' as const };
          }
          return w;
        });
      }
      if (state.activeId === 'edit') {
        state.activeId = 'scene';
        dirty = true;
      }
      if (dirty) localStorage.setItem(listKey, JSON.stringify(state));

      // 2. Rename per-workbench layout key: `<...>:workbench-layout:edit` → `:scene`.
      const projIdMatch = listKey.match(/^forgeax:project:(.+):workbenches$/);
      if (!projIdMatch) continue;
      const projId = projIdMatch[1];
      const oldLayoutKey = `forgeax:project:${projId}:workbench-layout:edit`;
      const newLayoutKey = `forgeax:project:${projId}:workbench-layout:scene`;
      const oldLayout = localStorage.getItem(oldLayoutKey);
      if (oldLayout !== null) {
        if (localStorage.getItem(newLayoutKey) === null) {
          localStorage.setItem(newLayoutKey, oldLayout);
        }
        localStorage.removeItem(oldLayoutKey);
      }
    }
  } catch (e) {
    console.error('[workbench] v8→v9 migration failed:', e);
  }
}

// ── v9 → v10 body ───────────────────────────────────────────────────────────
// The old interface-owned Scene layout can include editor ids which no longer
// exist. Layout content is now validated against the host manifest at runtime;
// remove every cached Scene layout proactively so it reseeds immediately.
function migrateV9toV10(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('forgeax:project:') && key.endsWith(':workbench-layout:scene')) {
        keys.push(key);
      }
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch (e) {
    console.error('[workbench] v9→v10 migration failed:', e);
  }
}

// ── Normalisation (shared by loadWorkbenchList + migration) ────────────────

/**
 * Normalise a persisted entry into a full Workbench record — fills in
 * defaults for T6 fields (isBuiltin, layout, panelLocations) that older
 * entries in localStorage don't carry. Applied on every load AND on every
 * entry produced by the v7→v8 migration.
 */
function normaliseEntry(entry: Partial<Workbench> & { id: string; name: string }): Workbench {
  const base: Workbench = {
    id: entry.id,
    name: entry.name,
    isBuiltin: BUILTIN_WORKBENCH_IDS.has(entry.id),
    layout: entry.layout ?? null,
    panelLocations: entry.panelLocations ?? {},
  };
  if (entry.icon) base.icon = entry.icon;
  if (entry.baselineOf) base.baselineOf = entry.baselineOf;
  return base;
}

/**
 * Canonicalise a list of workbenches:
 *   - drop retired ids (play/preview/viewport)
 *   - drop legacy 'workbench' entries (migration should have rewritten to 'ai',
 *     but be defensive)
 *   - built-ins first (canonical name/order from DEFAULT_WORKBENCHES), with
 *     persisted layout/panelLocations/icon carried over
 *   - user-added workspaces appended in original order, deduped
 */
function normaliseList(list: Workbench[]): Workbench[] {
  const customs = list
    .filter((w) => !BUILTIN_WORKBENCH_IDS.has(w.id) && !RETIRED_WORKBENCH_IDS.has(w.id) && w.id !== 'workbench' && w.id !== 'edit')
    .map((w) => normaliseEntry(w));

  const persistedById = new Map(list.map((w) => [w.id, w]));
  const builtins = DEFAULT_WORKBENCHES.map((def) => {
    // v9-compat: a persisted 'edit' entry (pre-migration or mid-flight) maps
    // to the 'scene' built-in. Layout is carried over via the layout-key
    // rename in migrateV8toV9; here we only fold the entry itself.
    const found = def.id === 'scene'
      ? (persistedById.get('scene') ?? persistedById.get('edit'))
      : persistedById.get(def.id);
    if (!found) return def;
    const norm = normaliseEntry({ ...found, id: def.id });
    return { ...norm, name: def.name };
  });
  return [...builtins, ...customs];
}

// ── Runtime storage sites (project-scoped) ────────────────────────────────

function saveState(state: WorkbenchListState): void {
  try {
    localStorage.setItem(
      workbenchesKeyForProject(currentProjectId),
      JSON.stringify(state),
    );
  } catch { /* quota */ }
}

/**
 * Public setter — persists the given state and notifies subscribers.
 * Hooks (useWorkbench.ts) use this to update per-workbench panelLocations /
 * layout. `saveState` alone doesn't notify; anything mutating list content
 * should go through this so `useSyncExternalStore` subscribers re-render.
 */
export function saveWorkbenchList(state: WorkbenchListState): void {
  saveState(state);
  notify();
}

export function loadWorkbenchList(): WorkbenchListState {
  // Belt+suspenders: ensures the migration ran even if setCurrentProject was
  // never called (e.g., /api/projects failed). Idempotent — no-op past current version.
  migrateWorkbenchSchema();

  try {
    const raw = localStorage.getItem(workbenchesKeyForProject(currentProjectId));
    if (raw) {
      const parsed = JSON.parse(raw) as WorkbenchListState;
      if (Array.isArray(parsed.list) && parsed.list.length > 0) {
        const list = normaliseList(parsed.list);
        // v9-compat: if the persisted activeId is 'edit', point it at 'scene'.
        const normalisedActive = parsed.activeId === 'edit' ? 'scene' : parsed.activeId;
        const activeId = list.find((w) => w.id === normalisedActive)
          ? normalisedActive
          : (list[0]?.id ?? 'scene');
        return { list, activeId };
      }
    }
  } catch { /* fall through */ }

  // No state for this project yet — seed from defaults.
  return { list: DEFAULT_WORKBENCHES, activeId: 'scene' };
}

export function setActiveWorkbench(id: string): void {
  const state = loadWorkbenchList();
  if (!state.list.find((w) => w.id === id)) return;
  if (state.activeId === id) return;
  saveState({ ...state, activeId: id });
  notify();
}

/**
 * Boot-time AppMode derived from the persisted active workspace.
 *
 * Bug (2026-06-19): the store hard-coded `mode: 'preview'` while the active
 * workspace tab was restored separately from localStorage. On refresh the tab
 * highlight showed the last workspace (e.g. AI / Scene) but the main area
 * rendered the Play preview — a mismatch the user hit while editing the story
 * tree. Deriving the initial `mode` from the restored workspace keeps the
 * highlighted tab and the rendered surface in sync after a refresh, with no
 * tab-then-content flash. Mirrors `modeForWorkbench()` in WorkbenchSwitcher.tsx
 * (kept standalone here to avoid a store ↔ component import cycle).
 *
 * 2026-07-07 (T3): AI workbench mode id renamed 'workbench' → 'ai'.
 * 2026-07-08 (v9): Scene workbench mode id renamed 'edit' → 'scene'.
 */
export function bootAppMode(): 'scene' | 'ai' {
  const { activeId } = loadWorkbenchList();
  // Only 'scene' pins to scene mode; every other id (including retired
  // 'preview'/'play' still lingering in stale localStorage, and any
  // user-created custom workbench) falls through to 'ai'.
  if (activeId === 'scene') return 'scene';
  return 'ai';
}

// ── Workbench CRUD ─────────────────────────────────────────────────────────

function nextWorkbenchName(list: Workbench[]): string {
  const existing = new Set(list.map((w) => w.name));
  for (let n = 1; n <= 200; n++) {
    const candidate = `Workbench ${n}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `Workbench ${list.length + 1}`;
}

export function addWorkbench(): Workbench {
  const state = loadWorkbenchList();
  const id = `ws-${Math.random().toString(36).slice(2, 8)}`;
  const entry: Workbench = {
    id,
    name: nextWorkbenchName(state.list),
    isBuiltin: false,
    layout: null,
    panelLocations: {},
  };
  saveState({ list: [...state.list, entry], activeId: state.activeId });
  notify();
  return entry;
}

export function renameWorkbench(id: string, name: string): void {
  const state = loadWorkbenchList();
  const idx = state.list.findIndex((w) => w.id === id);
  if (idx === -1) return;
  const list = [...state.list];
  list[idx] = { ...list[idx], name };
  saveState({ ...state, list });
  notify();
}

/**
 * Duplicate an existing workbench (built-in or custom) into a new custom entry.
 * The new workbench is appended to the end of the list (active state
 * unchanged — callers switch to it explicitly if desired). Layout and
 * panelLocations are deep-cloned so the two records diverge freely.
 *
 * `baselineOf` semantics:
 *   - Cloning a built-in ('scene'|'ai') → new entry's baselineOf = that id.
 *     Reset-to-default in the future will reseed from the source built-in.
 *   - Cloning a custom entry → preserves the source's own baselineOf (chain
 *     back to the original built-in, not to the intermediate custom).
 *
 * Returns the created Workbench, or null if sourceId is not in the list.
 */
export function duplicateWorkbench(sourceId: string): Workbench | null {
  const state = loadWorkbenchList();
  const source = state.list.find((w) => w.id === sourceId);
  if (!source) return null;
  const id = `ws-${Math.random().toString(36).slice(2, 8)}`;
  const name = uniqueDuplicateName(source.name, state.list);
  const entry: Workbench = {
    id,
    name,
    isBuiltin: false,
    // Built-in source ids are guaranteed to be 'scene' | 'ai' (BUILTIN_WORKBENCH_IDS).
    // The narrower baselineOf type ('scene' | 'ai') is enforced by TS at the
    // ternary; for custom sources we just carry their existing baselineOf through.
    baselineOf: source.isBuiltin
      ? (source.id === 'scene' || source.id === 'ai' ? source.id : undefined)
      : source.baselineOf,
    // Deep-clone via JSON so panel arrays / nested grid nodes don't alias.
    layout: source.layout ? (JSON.parse(JSON.stringify(source.layout)) as SerializedDockview) : null,
    panelLocations: { ...source.panelLocations },
  };
  if (source.icon) entry.icon = source.icon;
  saveState({ list: [...state.list, entry], activeId: state.activeId });
  notify();
  return entry;
}

/**
 * Pick a fresh "(copy)" / "(copy N)" name that doesn't collide with any
 * existing workbench name. Matches VSCode / Blender "duplicate" naming.
 */
function uniqueDuplicateName(base: string, list: Workbench[]): string {
  const existing = new Set(list.map((w) => w.name));
  const withCopy = `${base} (copy)`;
  if (!existing.has(withCopy)) return withCopy;
  for (let n = 2; n <= 200; n++) {
    const candidate = `${base} (copy ${n})`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base} (copy ${list.length + 1})`;
}

export function deleteWorkbench(id: string): void {
  if (BUILTIN_WORKBENCH_IDS.has(id)) return; // core workspaces are permanent
  const state = loadWorkbenchList();
  const list = state.list.filter((w) => w.id !== id);
  if (list.length === 0) return;
  const activeId = state.activeId === id ? (list[0]?.id ?? 'scene') : state.activeId;
  saveState({ list, activeId });
  try {
    localStorage.removeItem(workbenchLayoutKeyForProject(currentProjectId, id));
  } catch { /* quota */ }
  notify();
}

// ── Layout read (sync, from localStorage cache) ───────────────────────────

export function loadWorkbenchLayout(id: string): SerializedDockview | null {
  // Belt+suspenders (idempotent past v8).
  migrateWorkbenchSchema();
  try {
    const raw = localStorage.getItem(workbenchLayoutKeyForProject(currentProjectId, id));
    return raw ? (JSON.parse(raw) as SerializedDockview) : null;
  } catch { return null; }
}

// ── Layout write (sync to localStorage + debounced PUT to server) ──────────

const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();

// Backend-presence latch. Standalone (no server) serves the SPA index.html for
// every /api route, so the debounced PUT below would 404 and surface a console
// error for a write that can never persist. initWorkbenchLayouts() probes /api
// on boot and flips this to false when it sees non-JSON; the PUT then no-ops.
// Stays true until proven otherwise so the studio-embedded path is unchanged.
let serverHasPrefs = true;

export function saveWorkbenchLayout(id: string, layout: SerializedDockview): void {
  try {
    localStorage.setItem(
      workbenchLayoutKeyForProject(currentProjectId, id),
      JSON.stringify(layout),
    );
  } catch { /* quota */ }
  if (!serverHasPrefs) return; // standalone: localStorage is the only sink
  const prev = pendingSaves.get(id);
  if (prev !== undefined) clearTimeout(prev);
  pendingSaves.set(id, setTimeout(() => {
    pendingSaves.delete(id);
    // Re-check at fire time: the boot /api probe may have latched the backend
    // off in the 1.5s since this PUT was scheduled (standalone has no server).
    if (!serverHasPrefs) return;
    void fetch(`/api/prefs/workbench-layout/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(layout),
    }).catch(() => { /* non-critical */ });
  }, 1500));
}

// ── Startup init: load server layouts into localStorage when cache is empty ──

const REQUIRED_PANELS: Record<string, string[]> = {
  ai: ['main'],
};

/** Walk a serialized dockview grid tree and return true if any leaf has an
 *  empty `views: []` array. Empty leaves are the tell-tale of a corrupted
 *  save — dockview only serializes empty leaves when an addPanel call
 *  registered a group without any panel content (e.g., the T5 reactive
 *  effect's repeated failed adds before the panelLocations-gated fix).
 *  Once such a layout is loaded, every empty leaf renders as a divider,
 *  crushing all real panels into narrow columns. */
function hasEmptyLeaves(layout: unknown): boolean {
  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') return false;
    const n = node as { type?: string; data?: unknown };
    if (n.type === 'leaf') {
      const d = n.data as { views?: unknown } | undefined;
      const views = d?.views;
      return Array.isArray(views) && views.length === 0;
    }
    if (n.type === 'branch' && Array.isArray(n.data)) {
      return (n.data as unknown[]).some(walk);
    }
    return false;
  };
  const root = (layout as { grid?: { root?: unknown } } | undefined)?.grid?.root;
  return walk(root);
}

export function isLayoutStale(
  id: string,
  raw: string,
  activeEditorPanelIds: ReadonlySet<string>,
): boolean {
  try {
    const layout = JSON.parse(raw) as { panels?: Record<string, unknown> };
    const required = REQUIRED_PANELS[id];
    if (required?.some((p) => !layout.panels?.[p])) return true;
    if (layout.panels) {
      const panelIds = Object.keys(layout.panels);
      // Custom workspaces with ep:* panels have the old edit-style layout.
      if (!BUILTIN_WORKBENCH_IDS.has(id) && panelIds.some((k) => k.startsWith('ep:'))) return true;
      // Built-in layouts are host-owned. Reject a persisted panel that is no
      // longer declared by the host rather than reviving an unmounted tab.
      if (BUILTIN_WORKBENCH_IDS.has(id)) {
        if (panelIds.some((k) => k.startsWith('ep:') && !activeEditorPanelIds.has(k.slice(3)))) return true;
      }
    }
    // Empty-leaf corruption from the T5 reactive-add bug (2026-07-07).
    if (hasEmptyLeaves(layout)) return true;
    return false;
  } catch { return true; }
}

export async function initWorkbenchLayouts(
  activeEditorPanelIds: ReadonlySet<string>,
): Promise<void> {
  const { list } = loadWorkbenchList();
  await Promise.all(list.map(async ({ id }) => {
    const cacheKey = workbenchLayoutKeyForProject(currentProjectId, id);
    const cached = localStorage.getItem(cacheKey);
    if (cached && !isLayoutStale(id, cached, activeEditorPanelIds)) return;
    if (cached) localStorage.removeItem(cacheKey);
    try {
      const res = await fetch(`/api/prefs/workbench-layout/${id}`);
      if (!res.ok) return;
      // Standalone (no backend) serves the SPA index.html for unknown /api
      // routes — a 200 with text/html. Guard against parsing that as JSON, and
      // latch off the backend so later PUTs (saveWorkbenchLayout) don't 404.
      if (!res.headers.get('content-type')?.includes('application/json')) {
        serverHasPrefs = false;
        return;
      }
      const layout: unknown = await res.json();
      if (layout && typeof layout === 'object') {
        // Apply the SAME staleness check to the server-fetched layout — a
        // polluted server pref (e.g., empty-leaf corruption from the T5
        // reactive-add bug) would otherwise repopulate localStorage even
        // after migrateWorkbenchSchema() wiped it. Skip the save; the next
        // DockShell mount rebuilds from buildDefault().
        const raw = JSON.stringify(layout);
        if (isLayoutStale(id, raw, activeEditorPanelIds)) return;
        if (!localStorage.getItem(cacheKey)) {
          localStorage.setItem(cacheKey, raw);
        }
      }
    } catch { /* non-critical */ }
  }));
}
