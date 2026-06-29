// Workspace list + per-workspace dockview layout persistence.
// Primary storage: localStorage for fast sync reads; server-side JSON files
// (.forgeax/prefs/workspace-layouts/<id>.json) as durable fallback.
import type { SerializedDockview } from 'dockview';
import { STORAGE_KEYS } from './storageKeys';

export interface WorkspaceEntry { id: string; name: string }

const WS_STATE_KEY  = STORAGE_KEYS.workspaces;          // { list, activeId }
const WS_STATE_KEY_V1 = STORAGE_KEYS.workspacesLegacyV1; // legacy — migrate user workspaces from here
const WS_ACTIVE_KEY = STORAGE_KEYS.workspaceActiveLegacy; // legacy, kept for migration
const WS_LAYOUT_PREFIX = STORAGE_KEYS.wsLayoutPrefix;
const LEGACY_LAYOUT_KEY = STORAGE_KEYS.legacyDockLayout;
const LAYOUT_VERSION_KEY = STORAGE_KEYS.wsLayoutVersion;

// Built-in default-layout schema version. BUMP THIS whenever buildDefault()
// in DockShell.tsx changes the arrangement of a built-in workspace. On the
// next load, migrateLayoutVersion() discards every saved layout whose stamp is
// older, so existing users automatically pick up the new default WITHOUT having
// to hit "重置布局" manually. (Version 3: 2026-06 — evict layouts saved while
// editor iframes fell back to the outer Studio shell, causing nested workspaces.
// Version 4: 2026-06 — Info panel now defaults into the bottom History/Timeline/
// Capabilities group instead of floating top-right.)
export const CURRENT_LAYOUT_VERSION = 4;

// Core workspace IDs — always present, cannot be deleted.
export const CORE_WORKSPACE_IDS = new Set(['preview', 'edit', 'workbench']);

/**
 * One-shot migration: when the built-in layout schema version advances, wipe
 * every saved per-workspace dockview layout (and the legacy single-layout key)
 * so the next render rebuilds from the current buildDefault(). Idempotent —
 * once the stored stamp matches CURRENT_LAYOUT_VERSION it does nothing. Call
 * this BEFORE the first layout restore (DockShell onReady).
 */
export function migrateLayoutVersion(): void {
  try {
    const stored = Number(localStorage.getItem(LAYOUT_VERSION_KEY) || '0');
    if (stored >= CURRENT_LAYOUT_VERSION) return;
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(WS_LAYOUT_PREFIX)) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
    localStorage.removeItem(LEGACY_LAYOUT_KEY);
    localStorage.setItem(LAYOUT_VERSION_KEY, String(CURRENT_LAYOUT_VERSION));
  } catch { /* storage unavailable — fall back to per-load buildDefault */ }
}

export const DEFAULT_WORKSPACES: WorkspaceEntry[] = [
  { id: 'preview',   name: 'Play' },
  { id: 'edit',      name: 'Edit' },
  { id: 'workbench', name: 'AI' },  // "AI" display name; id stays 'workbench'
];

export interface WorkspaceState { list: WorkspaceEntry[]; activeId: string }

let listeners: Array<() => void> = [];
function notify(): void { listeners.forEach((fn) => fn()); }

export function subscribeWorkspaces(fn: () => void): () => void {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

function saveState(state: WorkspaceState): void {
  try { localStorage.setItem(WS_STATE_KEY, JSON.stringify(state)); } catch { /* quota */ }
  // keep legacy key in sync for any code that still reads it
  try { localStorage.setItem(WS_ACTIVE_KEY, state.activeId); } catch { /* quota */ }
}

export function loadWorkspaces(): WorkspaceState {
  // One-time migration: copy the old single-layout key into the edit workspace slot.
  if (!localStorage.getItem(`${WS_LAYOUT_PREFIX}edit`)) {
    try {
      const legacy = localStorage.getItem(LEGACY_LAYOUT_KEY);
      if (legacy) localStorage.setItem(`${WS_LAYOUT_PREFIX}edit`, legacy);
    } catch { /* noop */ }
  }

  // Core workspaces are always authoritative: names come from DEFAULT_WORKSPACES,
  // order matches DEFAULT_WORKSPACES (user-added workspaces go at the end).
  const normalise = (list: WorkspaceEntry[]): WorkspaceEntry[] => {
    const customs = list.filter((w) => !CORE_WORKSPACE_IDS.has(w.id));
    return [
      ...DEFAULT_WORKSPACES,   // always present, always in order, always canonical names
      ...customs,
    ];
  };

  try {
    const raw = localStorage.getItem(WS_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as WorkspaceState;
      if (Array.isArray(parsed.list) && parsed.list.length > 0) {
        const list = normalise(parsed.list);
        const activeId = list.find((w) => w.id === parsed.activeId)
          ? parsed.activeId
          : (list[0]?.id ?? 'edit');
        return { list, activeId };
      }
    }
  } catch { /* fall through */ }

  // Try v1 — preserve user-added (non-core) workspaces, update core names.
  try {
    const raw = localStorage.getItem(WS_STATE_KEY_V1);
    if (raw) {
      const parsed = JSON.parse(raw) as WorkspaceState;
      if (Array.isArray(parsed.list) && parsed.list.length > 0) {
        const list = normalise(parsed.list);
        const activeId = list.find((w) => w.id === parsed.activeId)
          ? parsed.activeId
          : (list[0]?.id ?? 'edit');
        return { list, activeId };
      }
    }
  } catch { /* fall through */ }

  // First run — seed from defaults.
  const legacyActive = localStorage.getItem(WS_ACTIVE_KEY);
  const activeId = DEFAULT_WORKSPACES.find((w) => w.id === legacyActive)
    ? legacyActive!
    : 'edit';
  return { list: DEFAULT_WORKSPACES, activeId };
}

export function setActiveWorkspace(id: string): void {
  const state = loadWorkspaces();
  if (!state.list.find((w) => w.id === id)) return;
  saveState({ ...state, activeId: id });
  notify();
}

/**
 * Boot-time AppMode derived from the persisted active workspace.
 *
 * Bug (2026-06-19): the store hard-coded `mode: 'preview'` while the active
 * workspace tab was restored separately from localStorage. On refresh the tab
 * highlight showed the last workspace (e.g. AI / Edit) but the main area
 * rendered the Play preview — a mismatch the user hit while editing the story
 * tree. Deriving the initial `mode` from the restored workspace keeps the
 * highlighted tab and the rendered surface in sync after a refresh, with no
 * tab-then-content flash. Mirrors `modeForWorkspace()` in WorkspaceTabs.tsx
 * (kept standalone here to avoid a store ↔ component import cycle).
 */
export function bootAppMode(): 'preview' | 'workbench' | 'edit' {
  const { activeId } = loadWorkspaces();
  if (activeId === 'preview') return 'preview';
  if (activeId === 'edit') return 'edit';
  return 'workbench';
}

// ── Workspace CRUD ─────────────────────────────────────────────────────────

function nextWorkspaceName(list: WorkspaceEntry[]): string {
  const existing = new Set(list.map((w) => w.name));
  for (let n = 1; n <= 200; n++) {
    const candidate = `Workspace ${n}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `Workspace ${list.length + 1}`;
}

export function addWorkspace(): WorkspaceEntry {
  const state = loadWorkspaces();
  const id = `ws-${Math.random().toString(36).slice(2, 8)}`;
  const entry: WorkspaceEntry = { id, name: nextWorkspaceName(state.list) };
  saveState({ list: [...state.list, entry], activeId: state.activeId });
  notify();
  return entry;
}

export function renameWorkspace(id: string, name: string): void {
  const state = loadWorkspaces();
  const idx = state.list.findIndex((w) => w.id === id);
  if (idx === -1) return;
  const list = [...state.list];
  list[idx] = { ...list[idx], name };
  saveState({ ...state, list });
  notify();
}

export function deleteWorkspace(id: string): void {
  if (CORE_WORKSPACE_IDS.has(id)) return; // core workspaces are permanent
  const state = loadWorkspaces();
  const list = state.list.filter((w) => w.id !== id);
  if (list.length === 0) return;
  const activeId = state.activeId === id ? (list[0]?.id ?? 'edit') : state.activeId;
  saveState({ list, activeId });
  try { localStorage.removeItem(`${WS_LAYOUT_PREFIX}${id}`); } catch { /* quota */ }
  notify();
}

// ── Layout read (sync, from localStorage cache) ───────────────────────────

export function loadWorkspaceLayout(id: string): SerializedDockview | null {
  try {
    const raw = localStorage.getItem(`${WS_LAYOUT_PREFIX}${id}`);
    return raw ? (JSON.parse(raw) as SerializedDockview) : null;
  } catch { return null; }
}

// ── Layout write (sync to localStorage + debounced PUT to server) ──────────

const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();

// Backend-presence latch. Standalone (no server) serves the SPA index.html for
// every /api route, so the debounced PUT below would 404 and surface a console
// error for a write that can never persist. initWorkspaceLayouts() probes /api
// on boot and flips this to false when it sees non-JSON; the PUT then no-ops.
// Stays true until proven otherwise so the studio-embedded path is unchanged.
let serverHasPrefs = true;

export function saveWorkspaceLayout(id: string, layout: SerializedDockview): void {
  try { localStorage.setItem(`${WS_LAYOUT_PREFIX}${id}`, JSON.stringify(layout)); } catch { /* quota */ }
  if (!serverHasPrefs) return; // standalone: localStorage is the only sink
  const prev = pendingSaves.get(id);
  if (prev !== undefined) clearTimeout(prev);
  pendingSaves.set(id, setTimeout(() => {
    pendingSaves.delete(id);
    // Re-check at fire time: the boot /api probe may have latched the backend
    // off in the 1.5s since this PUT was scheduled (standalone has no server).
    if (!serverHasPrefs) return;
    void fetch(`/api/prefs/workspace-layout/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(layout),
    }).catch(() => { /* non-critical */ });
  }, 1500));
}

// ── Startup init: load server layouts into localStorage when cache is empty ──

const REQUIRED_PANELS: Record<string, string[]> = {
  workbench: ['main'],
};

function isLayoutStale(id: string, raw: string): boolean {
  try {
    const layout = JSON.parse(raw) as { panels?: Record<string, unknown> };
    const required = REQUIRED_PANELS[id];
    if (required?.some((p) => !layout.panels?.[p])) return true;
    // Custom workspaces with ep:* panels have the old edit-style layout — stale.
    if (!CORE_WORKSPACE_IDS.has(id) && layout.panels) {
      if (Object.keys(layout.panels).some((k) => k.startsWith('ep:'))) return true;
    }
    return false;
  } catch { return true; }
}

export async function initWorkspaceLayouts(): Promise<void> {
  const { list } = loadWorkspaces();
  await Promise.all(list.map(async ({ id }) => {
    const cached = localStorage.getItem(`${WS_LAYOUT_PREFIX}${id}`);
    if (cached && !isLayoutStale(id, cached)) return;
    if (cached) localStorage.removeItem(`${WS_LAYOUT_PREFIX}${id}`);
    try {
      const res = await fetch(`/api/prefs/workspace-layout/${id}`);
      if (!res.ok) return;
      // Standalone (no backend) serves the SPA index.html for unknown /api
      // routes — a 200 with text/html. Guard against parsing that as JSON, and
      // latch off the backend so later PUTs (saveWorkspaceLayout) don't 404.
      if (!res.headers.get('content-type')?.includes('application/json')) {
        serverHasPrefs = false;
        return;
      }
      const layout: unknown = await res.json();
      if (layout && typeof layout === 'object') {
        if (!localStorage.getItem(`${WS_LAYOUT_PREFIX}${id}`)) {
          localStorage.setItem(`${WS_LAYOUT_PREFIX}${id}`, JSON.stringify(layout));
        }
      }
    } catch { /* non-critical */ }
  }));
}
