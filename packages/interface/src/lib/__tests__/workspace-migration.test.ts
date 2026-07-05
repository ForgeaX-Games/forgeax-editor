/**
 * AC-02: Persistence migration unit test.
 *
 * 2x2 redesign keeps the 'edit' workspace (now hosting the run x display
 * viewport) and drops the retired 'play'/'preview'/'viewport' ids. Verifies:
 * retired activeId falls back to 'edit', 'edit'/'workbench' stay unchanged,
 * unknown values fall back without error, and a persisted list carrying
 * retired tabs drops them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadWorkspaces, DEFAULT_WORKSPACES } from '../workspaces';
import { STORAGE_KEYS } from '../storageKeys';

const WS_STATE_KEY = STORAGE_KEYS.workspaces;

function setStoredWorkspaceState(activeId: string): void {
  localStorage.setItem(
    WS_STATE_KEY,
    JSON.stringify({
      list: DEFAULT_WORKSPACES,
      activeId,
    }),
  );
}

function clearStore(): void {
  localStorage.removeItem(WS_STATE_KEY);
  localStorage.removeItem(STORAGE_KEYS.workspaceActiveLegacy);
  localStorage.removeItem(STORAGE_KEYS.workspacesLegacyV1);
  // Keep layout version key to avoid type errors, just wipe state keys
}

describe('AC-02 workspace persistence migration', () => {
  beforeEach(() => {
    clearStore();
  });

  afterEach(() => {
    clearStore();
  });

  it("activeId='edit' stays 'edit' (kept as the 2x2 viewport workspace)", () => {
    setStoredWorkspaceState('edit');
    const state = loadWorkspaces();
    expect(state.activeId).toBe('edit');
  });

  it("retired activeId='preview' falls back to 'edit'", () => {
    setStoredWorkspaceState('preview');
    const state = loadWorkspaces();
    expect(state.activeId).toBe('edit');
  });

  it("retired activeId='play' falls back to 'edit'", () => {
    setStoredWorkspaceState('play');
    const state = loadWorkspaces();
    expect(state.activeId).toBe('edit');
  });

  it("retired activeId='viewport' falls back to 'edit'", () => {
    setStoredWorkspaceState('viewport');
    const state = loadWorkspaces();
    expect(state.activeId).toBe('edit');
  });

  it("activeId='workbench' stays 'workbench' (unchanged)", () => {
    setStoredWorkspaceState('workbench');
    const state = loadWorkspaces();
    expect(state.activeId).toBe('workbench');
  });

  it("unknown activeId falls back to first workspace (no crash, no blank)", () => {
    setStoredWorkspaceState('nonexistent');
    const state = loadWorkspaces();
    expect(state.list.length).toBeGreaterThan(0);
    expect(state.activeId).toBe(state.list[0].id); // 'edit'
  });

  it('missing activeId defaults to first workspace', () => {
    localStorage.setItem(
      WS_STATE_KEY,
      JSON.stringify({ list: DEFAULT_WORKSPACES }),
    );
    const state = loadWorkspaces();
    expect(state.list.length).toBeGreaterThan(0);
    expect(state.activeId).toBe(state.list[0].id);
  });

  it("persisted list carrying retired 'play'/'preview'/'viewport' tabs drops them (only edit + workbench + genuine customs remain)", () => {
    // Real-world case: an earlier session persisted a list with retired tabs.
    // They must NOT resurface as custom tabs alongside 'edit'.
    localStorage.setItem(
      WS_STATE_KEY,
      JSON.stringify({
        list: [
          { id: 'play', name: 'Play' },
          { id: 'preview', name: 'Preview' },
          { id: 'viewport', name: 'Viewport' },
          { id: 'edit', name: 'Edit' },
          { id: 'workbench', name: 'AI' },
          { id: 'my-custom', name: 'My Custom' },
        ],
        activeId: 'viewport',
      }),
    );
    const state = loadWorkspaces();
    const ids = state.list.map((w) => w.id);
    expect(ids).not.toContain('play');
    expect(ids).not.toContain('preview');
    expect(ids).not.toContain('viewport');
    expect(ids).toContain('edit');
    expect(ids).toContain('workbench');
    expect(ids).toContain('my-custom');        // genuine user workspace preserved
    expect(ids.filter((id) => id === 'edit')).toHaveLength(1); // no dup
    // activeId pointed at the retired 'viewport' → falls back to first (edit)
    expect(state.activeId).toBe('edit');
  });
});
