/**
 * T7 · Workbench schema migration (v7 → v8 → v9 → v10).
 *
 * v8 (2026-07-07) introduces project-scoped keys under `forgeax:project:${projId}:*` and
 * rewrites two deprecated ids inside every persisted layout:
 *   - workbench-id  'workbench' → 'ai'    (list entry + activeId)
 *   - panel-id      'workbench' → 'tools' (inside SerializedDockview)
 * The orphan global `forgeax:panel-locations` (T6 stopped writing it) is
 * inlined into every migrated Workbench.panelLocations, then deleted.
 *
 * v9 (2026-07-08) renames built-in Scene workbench id 'edit' → 'scene' across
 * every project namespace: Workbench.id, activeId, baselineOf, per-workbench
 * layout key. Also runs on top of v8 in a single migration pass.
 *
 * Also covers pre-v8 basics preserved from the earlier `workspace-migration`
 * suite: retired ids (play/preview/viewport) get dropped, unknown activeId
 * falls back to the first entry, missing activeId defaults, etc.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Legacy keys the migration reads from.
const LEGACY_WS = 'forgeax:workspaces:v2';
const LEGACY_WS_LAYOUT_PREFIX = 'forgeax:ws-layout:';
const LEGACY_PANEL_LOCATIONS = 'forgeax:panel-locations';
const LEGACY_VERSION_KEY = 'forgeax:ws-layout-version';

// New keys the migration writes to (project id defaults to 'default').
const V8_WB = 'forgeax:project:default:workbenches';
const V8_LAYOUT_PREFIX = 'forgeax:project:default:workbench-layout:';
const V8_VERSION_KEY = 'forgeax:workbench-schema-version';
const CURRENT_VERSION = '10';

async function reload() {
  return await import('../workbenches');
}

function clearAll(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch { /* noop */ }
}

describe('T7 workbench v7 → v8 → v9 → v10 migration', () => {
  let registered = false;
  beforeEach(async () => {
    try { GlobalRegistrator.register(); registered = true; } catch { registered = false; }
    clearAll();
    // Reset the module-level `currentProjectId` back to 'default' so each test
    // starts from the same boot-order state (production ships in this state
    // until ProjectSwitcher.reload() resolves /api/projects).
    const { __resetCurrentProjectIdForTests } = await reload();
    __resetCurrentProjectIdForTests();
  });
  afterEach(() => {
    clearAll();
    if (registered) GlobalRegistrator.unregister();
  });

  it('v7 → v9: rewrites activeId, list-entry id, panel-id, inlines panel-locations, renames edit → scene', async () => {
    // Seed a fully-populated v7 state.
    localStorage.setItem(LEGACY_WS, JSON.stringify({
      activeId: 'workbench',
      list: [
        { id: 'edit',      name: 'Edit' },
        { id: 'workbench', name: 'AI' },
      ],
    }));
    localStorage.setItem(`${LEGACY_WS_LAYOUT_PREFIX}workbench`, JSON.stringify({
      panels: { workbench: { id: 'workbench', component: 'workbench' } },
      grid: {
        root: {
          type: 'leaf',
          data: { views: ['workbench'], activeView: 'workbench' },
        },
      },
    }));
    localStorage.setItem(LEGACY_PANEL_LOCATIONS, JSON.stringify({ chat: 'AuxBar' }));
    localStorage.setItem(LEGACY_VERSION_KEY, '7');

    const { migrateWorkbenchSchema } = await reload();
    migrateWorkbenchSchema();

    // Legacy keys gone.
    expect(localStorage.getItem(LEGACY_WS)).toBeNull();
    expect(localStorage.getItem(`${LEGACY_WS_LAYOUT_PREFIX}workbench`)).toBeNull();
    expect(localStorage.getItem(LEGACY_PANEL_LOCATIONS)).toBeNull();
    expect(localStorage.getItem(LEGACY_VERSION_KEY)).toBeNull();

    // v9 state present under the default project namespace.
    const stateRaw = localStorage.getItem(V8_WB);
    expect(stateRaw).not.toBeNull();
    const state = JSON.parse(stateRaw!);
    expect(state.activeId).toBe('ai');
    // 'edit' renamed to 'scene' by the v8→v9 step; final canonical ids.
    expect(state.list.map((w: { id: string }) => w.id)).toEqual(['scene', 'ai']);
    // Names updated: 'Edit' → 'Scene' (the leftover verb is retired).
    const sceneEntry = state.list.find((w: { id: string }) => w.id === 'scene');
    expect(sceneEntry.name).toBe('Scene');

    // Panel-locations inlined into every workbench.
    for (const wb of state.list) {
      expect(wb.panelLocations).toEqual({ chat: 'AuxBar' });
    }

    // Layout rewritten and cached under the new key.
    const layoutRaw = localStorage.getItem(`${V8_LAYOUT_PREFIX}ai`);
    expect(layoutRaw).not.toBeNull();
    const layout = JSON.parse(layoutRaw!);
    expect(layout.panels.tools).toBeDefined();
    expect(layout.panels.workbench).toBeUndefined();
    expect(layout.panels.tools.id).toBe('tools');
    expect(layout.panels.tools.component).toBe('tools');
    expect(layout.grid.root.data.views).toEqual(['tools']);
    expect(layout.grid.root.data.activeView).toBe('tools');

    // Schema version stamped at current (v9).
    expect(localStorage.getItem(V8_VERSION_KEY)).toBe(CURRENT_VERSION);
  });

  it('migration is idempotent — second call is a no-op', async () => {
    localStorage.setItem(LEGACY_WS, JSON.stringify({
      activeId: 'workbench',
      list: [{ id: 'edit', name: 'Edit' }, { id: 'workbench', name: 'AI' }],
    }));
    localStorage.setItem(LEGACY_VERSION_KEY, '7');

    const { migrateWorkbenchSchema } = await reload();
    migrateWorkbenchSchema();

    const afterFirst = localStorage.getItem(V8_WB);
    expect(afterFirst).not.toBeNull();

    // Second run — snapshot every key value, run migration, compare.
    const snapshot = new Map<string, string>();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) snapshot.set(k, localStorage.getItem(k)!);
    }

    migrateWorkbenchSchema();

    expect(localStorage.length).toBe(snapshot.size);
    for (const [k, v] of snapshot) {
      expect(localStorage.getItem(k)).toBe(v);
    }
  });

  it('fresh install (no legacy state) just stamps the version', async () => {
    const { migrateWorkbenchSchema } = await reload();
    migrateWorkbenchSchema();
    // Only the version stamp is written — no workbench state fabricated.
    expect(localStorage.getItem(V8_VERSION_KEY)).toBe(CURRENT_VERSION);
    expect(localStorage.getItem(V8_WB)).toBeNull();
    expect(localStorage.getItem(`${V8_LAYOUT_PREFIX}ai`)).toBeNull();
    expect(localStorage.getItem(`${V8_LAYOUT_PREFIX}scene`)).toBeNull();
    expect(localStorage.getItem(`${V8_LAYOUT_PREFIX}edit`)).toBeNull();
  });

  it('setCurrentProject switches namespaces — project A vs project B', async () => {
    // Skip migration by pre-stamping current.
    localStorage.setItem(V8_VERSION_KEY, CURRENT_VERSION);
    // Seed project A with a custom workbench (uses post-v9 ids).
    localStorage.setItem('forgeax:project:A:workbenches', JSON.stringify({
      activeId: 'scene',
      list: [
        { id: 'scene',   name: 'Scene', isBuiltin: true, layout: null, panelLocations: {} },
        { id: 'ai',      name: 'AI',    isBuiltin: true, layout: null, panelLocations: {} },
        { id: 'ws-alpha', name: 'Alpha', isBuiltin: false, layout: null, panelLocations: {} },
      ],
    }));
    // Project B — only defaults will surface (no explicit seed).

    const { setCurrentProject, loadWorkbenchList } = await reload();

    setCurrentProject('A');
    const stateA = loadWorkbenchList();
    expect(stateA.list.map((w) => w.id)).toContain('ws-alpha');

    setCurrentProject('B');
    const stateB = loadWorkbenchList();
    expect(stateB.list.map((w) => w.id)).not.toContain('ws-alpha');
    expect(stateB.list.map((w) => w.id)).toEqual(['scene', 'ai']);
    expect(stateB.activeId).toBe('scene');
  });

  // ── v8 → v9: 'edit' → 'scene' renaming across project namespaces ────────

  it("v8 → v9: renames 'edit' → 'scene' in a v8-stamped project (list + activeId + layout key)", async () => {
    // User was previously stamped at v8 (pre-rename); no v7 legacy state present.
    localStorage.setItem(V8_VERSION_KEY, '8');
    localStorage.setItem(V8_WB, JSON.stringify({
      activeId: 'edit',
      list: [
        { id: 'edit', name: 'Edit', isBuiltin: true, layout: null, panelLocations: {} },
        { id: 'ai',   name: 'AI',   isBuiltin: true, layout: null, panelLocations: {} },
      ],
    }));
    localStorage.setItem(`${V8_LAYOUT_PREFIX}edit`, JSON.stringify({ marker: 'edit-layout' }));

    const { migrateWorkbenchSchema } = await reload();
    migrateWorkbenchSchema();

    const state = JSON.parse(localStorage.getItem(V8_WB)!);
    expect(state.activeId).toBe('scene');
    expect(state.list.map((w: { id: string }) => w.id)).toEqual(['scene', 'ai']);
    const sceneEntry = state.list.find((w: { id: string }) => w.id === 'scene');
    expect(sceneEntry.name).toBe('Scene');

    // v9 first renames the key; v10 then intentionally discards the cached
    // Scene layout so the host can reseed its injected authoritative layout.
    expect(localStorage.getItem(`${V8_LAYOUT_PREFIX}edit`)).toBeNull();
    expect(localStorage.getItem(`${V8_LAYOUT_PREFIX}scene`)).toBeNull();

    expect(localStorage.getItem(V8_VERSION_KEY)).toBe(CURRENT_VERSION);
  });

  it("v8 → v9: rewrites baselineOf 'edit' → 'scene' on custom entries", async () => {
    localStorage.setItem(V8_VERSION_KEY, '8');
    localStorage.setItem(V8_WB, JSON.stringify({
      activeId: 'ai',
      list: [
        { id: 'edit',   name: 'Edit', isBuiltin: true,  layout: null, panelLocations: {} },
        { id: 'ai',     name: 'AI',   isBuiltin: true,  layout: null, panelLocations: {} },
        { id: 'ws-abc', name: 'Custom', isBuiltin: false, baselineOf: 'edit', layout: null, panelLocations: {} },
      ],
    }));

    const { migrateWorkbenchSchema } = await reload();
    migrateWorkbenchSchema();

    const state = JSON.parse(localStorage.getItem(V8_WB)!);
    const custom = state.list.find((w: { id: string }) => w.id === 'ws-abc');
    expect(custom.baselineOf).toBe('scene');
  });

  it("v8 → v9: runs across every project namespace found in localStorage", async () => {
    localStorage.setItem(V8_VERSION_KEY, '8');
    // Two project scopes both carrying 'edit'.
    localStorage.setItem('forgeax:project:proj-a:workbenches', JSON.stringify({
      activeId: 'edit',
      list: [
        { id: 'edit', name: 'Edit', isBuiltin: true, layout: null, panelLocations: {} },
        { id: 'ai',   name: 'AI',   isBuiltin: true, layout: null, panelLocations: {} },
      ],
    }));
    localStorage.setItem('forgeax:project:proj-b:workbenches', JSON.stringify({
      activeId: 'ai',
      list: [
        { id: 'edit', name: 'Edit', isBuiltin: true, layout: null, panelLocations: {} },
        { id: 'ai',   name: 'AI',   isBuiltin: true, layout: null, panelLocations: {} },
      ],
    }));
    localStorage.setItem('forgeax:project:proj-a:workbench-layout:edit', JSON.stringify({ m: 'a' }));
    localStorage.setItem('forgeax:project:proj-b:workbench-layout:edit', JSON.stringify({ m: 'b' }));

    const { migrateWorkbenchSchema } = await reload();
    migrateWorkbenchSchema();

    const a = JSON.parse(localStorage.getItem('forgeax:project:proj-a:workbenches')!);
    expect(a.activeId).toBe('scene');
    expect(a.list.map((w: { id: string }) => w.id)).toEqual(['scene', 'ai']);
    const b = JSON.parse(localStorage.getItem('forgeax:project:proj-b:workbenches')!);
    expect(b.activeId).toBe('ai');
    expect(b.list.map((w: { id: string }) => w.id)).toEqual(['scene', 'ai']);

    expect(localStorage.getItem('forgeax:project:proj-a:workbench-layout:edit')).toBeNull();
    expect(localStorage.getItem('forgeax:project:proj-b:workbench-layout:edit')).toBeNull();
    // v10 clears the renamed Scene caches so each host can seed its injected layout.
    expect(localStorage.getItem('forgeax:project:proj-a:workbench-layout:scene')).toBeNull();
    expect(localStorage.getItem('forgeax:project:proj-b:workbench-layout:scene')).toBeNull();
  });

  // ── carry-overs from the pre-T7 workspace-migration suite ────────────────

  it("v7 seed with activeId='edit' migrates and lands on 'scene' (v9 rename)", async () => {
    localStorage.setItem(LEGACY_WS, JSON.stringify({
      activeId: 'edit',
      list: [{ id: 'edit', name: 'Edit' }, { id: 'ai', name: 'AI' }],
    }));
    localStorage.setItem(LEGACY_VERSION_KEY, '7');

    const { loadWorkbenchList } = await reload();
    const state = loadWorkbenchList();
    expect(state.activeId).toBe('scene');
  });

  it("retired activeId='preview' / 'play' / 'viewport' falls back to 'scene'", async () => {
    for (const bad of ['preview', 'play', 'viewport']) {
      clearAll();
      localStorage.setItem(LEGACY_WS, JSON.stringify({
        activeId: bad,
        list: [{ id: 'edit', name: 'Edit' }, { id: 'ai', name: 'AI' }],
      }));
      localStorage.setItem(LEGACY_VERSION_KEY, '7');

      const { loadWorkbenchList } = await reload();
      const state = loadWorkbenchList();
      expect(state.activeId).toBe('scene');
    }
  });

  it('unknown activeId falls back to first workbench (no crash, no blank)', async () => {
    localStorage.setItem(LEGACY_WS, JSON.stringify({
      activeId: 'nonexistent',
      list: [{ id: 'edit', name: 'Edit' }, { id: 'ai', name: 'AI' }],
    }));
    localStorage.setItem(LEGACY_VERSION_KEY, '7');

    const { loadWorkbenchList } = await reload();
    const state = loadWorkbenchList();
    expect(state.list.length).toBeGreaterThan(0);
    expect(state.activeId).toBe(state.list[0].id); // 'scene'
  });

  it("persisted list carrying retired 'play'/'preview'/'viewport' drops them", async () => {
    localStorage.setItem(LEGACY_WS, JSON.stringify({
      activeId: 'viewport',
      list: [
        { id: 'play',      name: 'Play' },
        { id: 'preview',   name: 'Preview' },
        { id: 'viewport',  name: 'Viewport' },
        { id: 'edit',      name: 'Edit' },
        { id: 'ai',        name: 'AI' },
        { id: 'my-custom', name: 'My Custom' },
      ],
    }));
    localStorage.setItem(LEGACY_VERSION_KEY, '7');

    const { loadWorkbenchList } = await reload();
    const state = loadWorkbenchList();
    const ids = state.list.map((w) => w.id);
    expect(ids).not.toContain('play');
    expect(ids).not.toContain('preview');
    expect(ids).not.toContain('viewport');
    // 'edit' was rewritten to 'scene' by v9; the persisted 'edit' entry maps
    // to the 'scene' built-in.
    expect(ids).not.toContain('edit');
    expect(ids).toContain('scene');
    expect(ids).toContain('ai');
    expect(ids).toContain('my-custom');
    expect(ids.filter((id) => id === 'scene')).toHaveLength(1); // no dup
    expect(state.activeId).toBe('scene');
  });

  // ── Boot-order race: setCurrentProject rescues 'default'-scoped state ────
  //
  // In production, DockRegion.onReady() calls migrateWorkbenchSchema() BEFORE
  // ProjectSwitcher.reload() resolves /api/projects. At that moment
  // `currentProjectId` is still its module-init fallback ('default'), so
  // migrated state gets written under `forgeax:project:default:*`. When
  // setCurrentProject('real-id') fires later, the state is stranded — the
  // user sees a fresh workbench. The transfer path below fixes that.

  it("boot-order race: migration under 'default' is transferred on first setCurrentProject('real-id')", async () => {
    // Seed v7 state; migrate under the module-init 'default' id (simulates the
    // DockRegion.onReady path firing before /api/projects resolves).
    localStorage.setItem(LEGACY_WS, JSON.stringify({
      activeId: 'workbench',
      list: [
        { id: 'edit',      name: 'Edit' },
        { id: 'workbench', name: 'AI' },
      ],
    }));
    localStorage.setItem(`${LEGACY_WS_LAYOUT_PREFIX}workbench`, JSON.stringify({
      panels: { workbench: { id: 'workbench', component: 'workbench' } },
      grid: {
        root: {
          type: 'leaf',
          data: { views: ['workbench'], activeView: 'workbench' },
        },
      },
    }));
    localStorage.setItem(LEGACY_VERSION_KEY, '7');

    const { migrateWorkbenchSchema, setCurrentProject } = await reload();
    migrateWorkbenchSchema();
    // Sanity: migration wrote state under 'default'.
    expect(localStorage.getItem(V8_WB)).not.toBeNull();
    expect(localStorage.getItem(`${V8_LAYOUT_PREFIX}ai`)).not.toBeNull();

    // Real project id arrives — state should transfer to that scope.
    setCurrentProject('my-project-id');

    // 'default:*' keys cleared.
    expect(localStorage.getItem(V8_WB)).toBeNull();
    expect(localStorage.getItem(`${V8_LAYOUT_PREFIX}ai`)).toBeNull();

    // Real project keys populated with the migrated shape (post-v9).
    const listRaw = localStorage.getItem('forgeax:project:my-project-id:workbenches');
    expect(listRaw).not.toBeNull();
    const list = JSON.parse(listRaw!);
    expect(list.activeId).toBe('ai');
    expect(list.list.map((w: { id: string }) => w.id)).toEqual(['scene', 'ai']);

    const layoutRaw = localStorage.getItem('forgeax:project:my-project-id:workbench-layout:ai');
    expect(layoutRaw).not.toBeNull();
    const layout = JSON.parse(layoutRaw!);
    expect(layout.panels.tools).toBeDefined();
    expect(layout.panels.workbench).toBeUndefined();
  });

  it("transfer is idempotent and does not overwrite existing target state", async () => {
    // Skip migration by pre-stamping current.
    localStorage.setItem(V8_VERSION_KEY, CURRENT_VERSION);
    // Stale 'default' state (from a botched migration under the fallback id).
    const staleDefault = {
      activeId: 'ai',
      list: [
        { id: 'scene', name: 'Scene', isBuiltin: true, layout: null, panelLocations: {} },
        { id: 'ai',   name: 'AI',   isBuiltin: true, layout: null, panelLocations: { chat: 'AuxBar' } },
      ],
    };
    localStorage.setItem(V8_WB, JSON.stringify(staleDefault));
    localStorage.setItem(`${V8_LAYOUT_PREFIX}ai`, JSON.stringify({ marker: 'default-stale' }));

    // Target project already has real state from an earlier user session.
    const targetExisting = {
      activeId: 'scene',
      list: [
        { id: 'scene', name: 'Scene', isBuiltin: true, layout: null, panelLocations: {} },
        { id: 'ai',   name: 'AI',   isBuiltin: true, layout: null, panelLocations: {} },
        { id: 'ws-real', name: 'Real', isBuiltin: false, layout: null, panelLocations: {} },
      ],
    };
    const targetKey = 'forgeax:project:my-id:workbenches';
    const targetLayoutKey = 'forgeax:project:my-id:workbench-layout:ai';
    localStorage.setItem(targetKey, JSON.stringify(targetExisting));
    localStorage.setItem(targetLayoutKey, JSON.stringify({ marker: 'target-real' }));

    const { setCurrentProject } = await reload();
    setCurrentProject('my-id');

    // Target state is UNCHANGED — target wins.
    const afterListRaw = localStorage.getItem(targetKey);
    expect(afterListRaw).not.toBeNull();
    expect(JSON.parse(afterListRaw!)).toEqual(targetExisting);

    const afterLayoutRaw = localStorage.getItem(targetLayoutKey);
    expect(afterLayoutRaw).not.toBeNull();
    expect(JSON.parse(afterLayoutRaw!)).toEqual({ marker: 'target-real' });

    // Source ('default:*') is DELETED — stray keys cleared, so re-invocation
    // is a no-op.
    expect(localStorage.getItem(V8_WB)).toBeNull();
    expect(localStorage.getItem(`${V8_LAYOUT_PREFIX}ai`)).toBeNull();
  });

  it('v9 → v10 discards cached Scene layouts so the host reseeds them', async () => {
    localStorage.setItem(V8_VERSION_KEY, '9');
    localStorage.setItem(`${V8_LAYOUT_PREFIX}scene`, JSON.stringify({
      panels: {
        'ep:material': { id: 'ep:material' },
        viewport: { id: 'viewport' },
      },
    }));
    localStorage.setItem(`${V8_LAYOUT_PREFIX}ai`, JSON.stringify({ marker: 'keep-ai' }));

    const { migrateWorkbenchSchema } = await reload();
    migrateWorkbenchSchema();

    expect(localStorage.getItem(`${V8_LAYOUT_PREFIX}scene`)).toBeNull();
    expect(JSON.parse(localStorage.getItem(`${V8_LAYOUT_PREFIX}ai`)!)).toEqual({ marker: 'keep-ai' });
    expect(localStorage.getItem(V8_VERSION_KEY)).toBe(CURRENT_VERSION);
  });

  it('treats a built-in unknown ep:* panel as stale against the injected manifest', async () => {
    const { isLayoutStale } = await reload();
    const raw = JSON.stringify({
      panels: {
        viewport: { id: 'viewport' },
        'ep:material': { id: 'ep:material' },
      },
      grid: { root: { type: 'leaf', data: { views: ['viewport', 'ep:material'] } } },
    });
    expect(isLayoutStale('scene', raw, new Set(['hierarchy']))).toBe(true);
    expect(isLayoutStale('scene', raw, new Set(['hierarchy', 'material']))).toBe(false);
  });

  it("legacy workbench-id entry ('workbench') is rewritten to 'ai' by list normalisation", async () => {
    // Even if a stale 'workbench' entry escapes the migration id-rewrite (e.g.,
    // second-write after migration), normaliseList drops it because 'ai' is
    // already a built-in — no zombie 'workbench' tab.
    localStorage.setItem(V8_VERSION_KEY, CURRENT_VERSION);
    localStorage.setItem(V8_WB, JSON.stringify({
      activeId: 'workbench',
      list: [
        { id: 'scene',     name: 'Scene',    isBuiltin: true,  layout: null, panelLocations: {} },
        { id: 'ai',        name: 'AI',        isBuiltin: true,  layout: null, panelLocations: {} },
        { id: 'workbench', name: 'Old AI',    isBuiltin: false, layout: null, panelLocations: {} },
      ],
    }));

    const { loadWorkbenchList } = await reload();
    const state = loadWorkbenchList();
    const ids = state.list.map((w) => w.id);
    expect(ids).toEqual(['scene', 'ai']);
    // activeId 'workbench' not in normalised list → falls back.
    expect(state.activeId).toBe('scene');
  });
});
