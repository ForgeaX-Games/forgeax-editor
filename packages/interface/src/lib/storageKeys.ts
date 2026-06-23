// Storage key registry — the single place every localStorage key the interface
// owns is declared (architecture review §D). Before this, ~17 `forgeax:*` keys
// with ad-hoc versions (v1/v2/v4/v5) were scattered across modules with no map,
// making migrations easy to miss and collisions easy to introduce.
//
// RULE: never inline a `'forgeax…'` localStorage key string in a component.
// Add it here (with a one-line purpose + version note) and import the const.
//
// Versioning: when a value's SHAPE changes incompatibly, bump its key suffix
// (…:v2 → …:v3) and add a migration. The dockview layout uses a separate
// numeric stamp (LAYOUT_VERSION) handled by workspaces.migrateLayoutVersion().

export const STORAGE_KEYS = {
  // ── workspaces (Blender-style named layouts) ──
  /** { list: WorkspaceEntry[]; activeId } — current workspace list + selection. */
  workspaces: 'forgeax:workspaces:v2',
  /** legacy v1 of the above — read once to migrate user workspaces, then ignored. */
  workspacesLegacyV1: 'forgeax:workspaces:v1',
  /** legacy active-id key — kept in sync for old readers / migration. */
  workspaceActiveLegacy: 'forgeax:workspace:active',
  /** prefix; full key is `${wsLayoutPrefix}<workspaceId>` → SerializedDockview. */
  wsLayoutPrefix: 'forgeax:ws-layout:',
  /** numeric stamp of the built-in default-layout schema (see CURRENT_LAYOUT_VERSION). */
  wsLayoutVersion: 'forgeax:ws-layout-version',
  /** legacy single-layout key (pre-workspaces) — read once for migration. */
  legacyDockLayout: 'forgeax:shell:dock:v4',

  // ── session / chat shell (store.ts) ──
  /** persisted open chat tabs. */
  tabs: 'forgeax.tabs',
  /** active session id. */
  activeSid: 'forgeax.activeSid',
  /** active tab id. */
  activeTabId: 'forgeax.activeTabId',
  /** pinned game slug (preview/agents scoping). */
  pinnedSlug: 'forgeax.pinnedSlug',
  /** first-run boot splash seen flag. */
  bootSplash: 'forgeax.boot.splash.v1',
} as const;

/** Build a per-workspace dockview layout key. */
export const wsLayoutKey = (workspaceId: string): string => `${STORAGE_KEYS.wsLayoutPrefix}${workspaceId}`;

// Cross-component window CustomEvent names (NOT storage, but same "stringly-typed
// global namespace" footgun — centralized here so they can't drift either).
export const APP_EVENTS = {
  dockLayoutToggle: 'forgeax:shell:dock-layout-toggle',
  dockReset: 'forgeax:shell:dock-reset',
  animHandoff: 'forgeax:anim-handoff',
} as const;
