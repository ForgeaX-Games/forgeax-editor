import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// T6/T7 test suite. Exercises the semantics that back useWorkbench.ts hooks:
// per-workbench panelLocations isolation, moveTo / resetPanelLocations,
// subscribe fanout on updates. The hooks themselves are thin `useSyncExternalStore`
// wrappers around loadWorkbenchList / saveWorkbenchList — we validate the
// underlying data flow, which is what the hooks project into React.
//
// 2026-07-07 (T7): keys are project-scoped. Default project id is 'default'
// unless setCurrentProject() is called; tests here rely on that default.
// 2026-07-08 (v9): built-in Scene workbench id is 'scene' (renamed from 'edit').
const WB_STATE_KEY = 'forgeax:project:default:workbenches';
// Stamp the current schema version so migrateWorkbenchSchema() (called by
// loadWorkbenchList as belt+suspenders) treats the store as already-migrated;
// otherwise it would see "no legacy state" and stamp on its own — either way
// harmless, but the explicit stamp keeps intent clear.
const SCHEMA_VERSION_KEY = 'forgeax:workbench-schema-version';
const CURRENT_VERSION = '9';

async function reload() {
  // Bun caches modules per-process; each test's beforeEach clears storage
  // so `loadWorkbenchList` returns a fresh state derived from the empty store.
  return await import('./workbenches');
}

describe('useWorkbench (data layer)', () => {
  let registered = false;
  beforeEach(() => {
    try { GlobalRegistrator.register(); registered = true; } catch { registered = false; }
    try { localStorage.clear(); } catch { /* noop */ }
  });
  afterEach(() => { if (registered) GlobalRegistrator.unregister(); });

  it('DEFAULT_WORKBENCHES has isBuiltin=true and empty panelLocations', async () => {
    const { DEFAULT_WORKBENCHES } = await reload();
    expect(DEFAULT_WORKBENCHES).toEqual([
      { id: 'scene', name: 'Scene', isBuiltin: true, layout: null, panelLocations: {} },
      { id: 'ai',    name: 'AI',    isBuiltin: true, layout: null, panelLocations: {} },
    ]);
  });

  it('loadWorkbenchList normalises legacy {id,name} entries with T6 defaults', async () => {
    localStorage.setItem(SCHEMA_VERSION_KEY, CURRENT_VERSION);
    localStorage.setItem(WB_STATE_KEY, JSON.stringify({
      activeId: 'scene',
      list: [
        { id: 'scene', name: 'Scene' },
        { id: 'ai',   name: 'AI' },
        { id: 'ws-abc', name: 'Custom' },
      ],
    }));
    const { loadWorkbenchList } = await reload();
    const state = loadWorkbenchList();
    expect(state.list).toHaveLength(3);
    expect(state.list[0]).toEqual({ id: 'scene', name: 'Scene', isBuiltin: true, layout: null, panelLocations: {} });
    expect(state.list[2]).toEqual({ id: 'ws-abc', name: 'Custom', isBuiltin: false, layout: null, panelLocations: {} });
  });

  it('saveWorkbenchList persists to project-scoped key and notifies subscribers', async () => {
    localStorage.setItem(SCHEMA_VERSION_KEY, CURRENT_VERSION);
    const { loadWorkbenchList, saveWorkbenchList, subscribeWorkbenchList } = await reload();
    let notified = 0;
    const unsub = subscribeWorkbenchList(() => { notified += 1; });
    const initial = loadWorkbenchList();
    saveWorkbenchList({
      activeId: 'scene',
      list: initial.list.map((w) =>
        w.id === 'scene' ? { ...w, panelLocations: { chat: 'AuxBar' } } : w,
      ),
    });
    unsub();
    expect(notified).toBe(1);
    const persisted = JSON.parse(localStorage.getItem(WB_STATE_KEY) ?? '{}');
    const sceneEntry = persisted.list.find((w: { id: string }) => w.id === 'scene');
    expect(sceneEntry.panelLocations).toEqual({ chat: 'AuxBar' });
  });

  it('moveTo updates only the ACTIVE workbench, sibling untouched', async () => {
    const { loadWorkbenchList, saveWorkbenchList } = await reload();
    // Simulate active workbench = 'scene'; move a panel on it.
    const initial = loadWorkbenchList();
    // Apply the same mutation the hook applies via updateActive:
    const idx = initial.list.findIndex((w) => w.id === initial.activeId);
    const next = {
      ...initial,
      list: initial.list.map((w, i) =>
        i === idx ? { ...w, panelLocations: { ...w.panelLocations, chat: 'AuxBar' as const } } : w,
      ),
    };
    saveWorkbenchList(next);

    const after = loadWorkbenchList();
    const sceneWb = after.list.find((w) => w.id === 'scene');
    const aiWb = after.list.find((w) => w.id === 'ai');
    // Assuming activeId defaults to 'scene', scene gets the override; ai does not.
    expect(sceneWb?.panelLocations).toEqual({ chat: 'AuxBar' });
    expect(aiWb?.panelLocations).toEqual({});
  });

  it('resetPanelLocations clears active workbench only', async () => {
    const { loadWorkbenchList, saveWorkbenchList } = await reload();
    // Seed both built-ins with an override, then reset only the active one.
    const seeded = {
      activeId: 'scene',
      list: [
        { id: 'scene', name: 'Scene', isBuiltin: true, layout: null, panelLocations: { chat: 'AuxBar' as const } },
        { id: 'ai',    name: 'AI',    isBuiltin: true, layout: null, panelLocations: { tools: 'AuxBar' as const } },
      ],
    };
    saveWorkbenchList(seeded);

    // Reset the active ('scene') workbench, mirroring updateActive(w => ({...w, panelLocations: {}})).
    const state = loadWorkbenchList();
    saveWorkbenchList({
      ...state,
      list: state.list.map((w) => (w.id === state.activeId ? { ...w, panelLocations: {} } : w)),
    });

    const after = loadWorkbenchList();
    expect(after.list.find((w) => w.id === 'scene')?.panelLocations).toEqual({});
    // Sibling 'ai' still carries its override — isolation preserved.
    expect(after.list.find((w) => w.id === 'ai')?.panelLocations).toEqual({ tools: 'AuxBar' });
  });

  it('subscribeWorkbenchList delivers to multiple listeners', async () => {
    const { saveWorkbenchList, subscribeWorkbenchList, loadWorkbenchList } = await reload();
    let a = 0, b = 0;
    const unsubA = subscribeWorkbenchList(() => { a += 1; });
    const unsubB = subscribeWorkbenchList(() => { b += 1; });
    saveWorkbenchList(loadWorkbenchList());
    unsubA(); unsubB();
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('resolveRegion still resolves override → default → DockShell', async () => {
    const { resolveRegion } = await import('../components/DockShell/resolveRegion');
    expect(resolveRegion('chat', { defaultRegion: 'DockShell' }, { chat: 'AuxBar' })).toBe('AuxBar');
    expect(resolveRegion('chat', { defaultRegion: 'AuxBar' }, {})).toBe('AuxBar');
    expect(resolveRegion('chat', {}, {})).toBe('DockShell');
  });

  // P3.5 · duplicateWorkbench: clone a workbench into a new custom entry.
  // Covers not-found, built-in clone (baselineOf semantics), name-collision
  // "(copy N)" suffix, and deep-clone of layout / panelLocations.
  describe('duplicateWorkbench', () => {
    it('returns null when sourceId is not in the list', async () => {
      localStorage.setItem(SCHEMA_VERSION_KEY, CURRENT_VERSION);
      const { duplicateWorkbench } = await reload();
      expect(duplicateWorkbench('does-not-exist')).toBeNull();
    });

    it('cloning a built-in creates a new custom entry with baselineOf set', async () => {
      localStorage.setItem(SCHEMA_VERSION_KEY, CURRENT_VERSION);
      const { duplicateWorkbench, loadWorkbenchList } = await reload();
      const created = duplicateWorkbench('scene');
      expect(created).not.toBeNull();
      expect(created!.isBuiltin).toBe(false);
      expect(created!.baselineOf).toBe('scene');
      expect(created!.name).toBe('Scene (copy)');
      const state = loadWorkbenchList();
      // Appended to end; active unchanged.
      expect(state.list[state.list.length - 1].id).toBe(created!.id);
      expect(state.activeId).toBe('scene');
    });

    it('cloning a custom entry preserves the source baselineOf (not re-anchors)', async () => {
      localStorage.setItem(SCHEMA_VERSION_KEY, CURRENT_VERSION);
      const { saveWorkbenchList, duplicateWorkbench } = await reload();
      // Seed a custom workbench baselined off 'ai'.
      saveWorkbenchList({
        activeId: 'scene',
        list: [
          { id: 'scene', name: 'Scene', isBuiltin: true, layout: null, panelLocations: {} },
          { id: 'ai',    name: 'AI',    isBuiltin: true, layout: null, panelLocations: {} },
          { id: 'ws-abc', name: 'Custom', isBuiltin: false, baselineOf: 'ai', layout: null, panelLocations: {} },
        ],
      });
      const created = duplicateWorkbench('ws-abc');
      expect(created).not.toBeNull();
      expect(created!.baselineOf).toBe('ai'); // chained through, not undefined
      expect(created!.isBuiltin).toBe(false);
      expect(created!.name).toBe('Custom (copy)');
    });

    it('deep-clones layout and panelLocations (mutating source does not affect copy)', async () => {
      localStorage.setItem(SCHEMA_VERSION_KEY, CURRENT_VERSION);
      const { saveWorkbenchList, duplicateWorkbench } = await reload();
      const sourceLayout = {
        panels: { main: { id: 'main', component: 'main' } },
        grid: { root: { type: 'branch', data: [{ type: 'leaf', data: { views: ['main'] } }] }, height: 100, width: 100, orientation: 'HORIZONTAL' as const },
      };
      saveWorkbenchList({
        activeId: 'scene',
        list: [
          {
            id: 'scene', name: 'Scene', isBuiltin: true,
            // Cast is fine for the deep-clone semantics test — we don't need a
            // full valid SerializedDockview to prove object identity is broken.
            layout: sourceLayout as unknown as import('dockview').SerializedDockview,
            panelLocations: { chat: 'AuxBar' as const },
          },
          { id: 'ai', name: 'AI', isBuiltin: true, layout: null, panelLocations: {} },
        ],
      });
      const created = duplicateWorkbench('scene');
      expect(created).not.toBeNull();
      // Object identity broken — the copy is a separate structure.
      expect(created!.layout).not.toBe(sourceLayout);
      expect(created!.panelLocations).not.toBe(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        (await reload()).loadWorkbenchList().list[0]!.panelLocations,
      );
      // Same content though.
      expect(created!.panelLocations).toEqual({ chat: 'AuxBar' });
      expect(created!.layout).toEqual(sourceLayout);
    });

    it('suffix increments when "(copy)" already taken', async () => {
      localStorage.setItem(SCHEMA_VERSION_KEY, CURRENT_VERSION);
      const { saveWorkbenchList, duplicateWorkbench } = await reload();
      saveWorkbenchList({
        activeId: 'scene',
        list: [
          { id: 'scene', name: 'Scene', isBuiltin: true, layout: null, panelLocations: {} },
          { id: 'ai',    name: 'AI',    isBuiltin: true, layout: null, panelLocations: {} },
          { id: 'ws-a', name: 'Scene (copy)', isBuiltin: false, baselineOf: 'scene', layout: null, panelLocations: {} },
        ],
      });
      const created = duplicateWorkbench('scene');
      expect(created!.name).toBe('Scene (copy 2)');
    });
  });
});
