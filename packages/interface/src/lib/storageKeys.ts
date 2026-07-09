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
// numeric stamp (LAYOUT_VERSION) handled by workspaces.migrateWorkbenchSchema().

export const STORAGE_KEYS = {
  // ── workbenches (Blender-style named layouts) ──
  //
  // NOTE: after the v7→v8 migration (T7 · 2026-07-07), all workbench state
  // lives under project-scoped keys (see `workbenchesKeyForProject` /
  // `workbenchLayoutKeyForProject` below). The keys listed here are LEGACY —
  // read once by `migrateWorkbenchSchema()` on first boot after upgrade to
  // recover pre-v8 user state, then deleted. No runtime read/write path
  // should touch them.
  /** [LEGACY, v7] { list: Workbench[]; activeId } — pre-v8 global workbench list + selection. */
  workspaces: 'forgeax:workspaces:v2',
  /** [LEGACY, v7] pre-v2 shape of the above — read once by migration. */
  workspacesLegacyV1: 'forgeax:workspaces:v1',
  /** [LEGACY, v7] pre-v2 active-id key — read once by migration. */
  workspaceActiveLegacy: 'forgeax:workspace:active',
  /** [LEGACY, v7] prefix; full key is `${wsLayoutPrefix}<workbenchId>` → SerializedDockview. */
  wsLayoutPrefix: 'forgeax:ws-layout:',
  /** [LEGACY, v7] numeric stamp of the built-in default-layout schema. Replaced by `workbenchSchemaVersionKey`. */
  wsLayoutVersion: 'forgeax:ws-layout-version',
  /** [LEGACY, pre-workspaces] single-layout key — read once by migration. */
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
  /** first-run onboarding state machine (welcome→project→home). Shape:
   *  OnboardingPersisted (see components/Onboarding/types). v2 supersedes the
   *  legacy boolean `onboardingSeenLegacy`, which is read once to migrate. */
  onboarding: 'forgeax.onboarding.v2',
  /** legacy boolean "onboarding dismissed" flag (pre state-machine) — read once
   *  to migrate existing users past the first-run wizard, then ignored. */
  onboardingSeenLegacy: 'forgeax.onboarding.seen',

  // ── i18n ──
  /** active UI language code ('en' | 'zh' | …). English is the default/source. */
  locale: 'forgeax.locale',

  // ── model routing ──
  /** persistent cli provider override (store.ts). null → native forgeax path. */
  providerOverride: 'forgeax.providerOverride',
  /** { [providerKey]: modelId } — last model the user HAND-PICKED per provider
   *  (providerKey = cli-id | 'forgeax'). New sessions seed from this so the
   *  picker lands on "where I left off"; a provider SWITCH still resets to the
   *  provider default. See lib/model-prefs.ts. */
  lastModelByProvider: 'forgeax.lastModel.byProvider.v1',

  // ── reply language ──
  /** agent chat reply language ('en' | 'zh'). Global, decoupled from UI locale.
   *  Default 'en'. Overridden per-turn by followInput when that is enabled. */
  replyLanguage: 'forgeax.replyLanguage',
  /** when '1', the agent reply language follows the detected language of each
   *  user message (highest priority). Default enabled ('1'). */
  followInput: 'forgeax.followInput',

  // ── publish module ──
  /** when '1', the first-run Publish coach-mark has been seen (or skipped). */
  publishOnboarded: 'forgeax.publish.onboarded',
} as const;

/** Build a per-workspace dockview layout key. Legacy — kept for the v7→v8
 *  migration to READ from; runtime paths use `workbenchLayoutKeyForProject`. */
export const wsLayoutKey = (workbenchId: string): string => `${STORAGE_KEYS.wsLayoutPrefix}${workbenchId}`;

// ── project-scoped workbench keys (v8 schema · T7) ─────────────────────────
//
// Post-v8, workbench state is namespaced under the current project id so
// switching projects re-reads a per-project list + per-project layouts. The
// project id is set by `setCurrentProject(projId)` (workbenches.ts), driven by
// ProjectSwitcher.tsx after `/api/projects` returns.
/** Per-project workbench list + active selection. { list: Workbench[]; activeId } */
export const workbenchesKeyForProject = (projId: string): string =>
  `forgeax:project:${projId}:workbenches`;
/** Per-project, per-workbench dockview layout cache (SerializedDockview). */
export const workbenchLayoutKeyForProject = (projId: string, wbId: string): string =>
  `forgeax:project:${projId}:workbench-layout:${wbId}`;
/** Schema-version stamp (replaces the legacy `wsLayoutVersion`). Global —
 *  the version applies to the on-disk layout across every project. */
export const workbenchSchemaVersionKey = 'forgeax:workbench-schema-version';
/** Legacy global panel-region overrides map — inlined into every workbench's
 *  panelLocations by the v7→v8 migration, then deleted. Kept as a constant
 *  so the migration can reference it by name. */
export const legacyPanelLocationsKey = 'forgeax:panel-locations';

// Session-scoped keys (sessionStorage, per-tab — NOT persisted like the above).
export const SESSION_KEYS = {
  /** last-activated workspace absPath — dedups the `workspace-changed` reload
   *  (see boot/broadcast.ts + lib/workspace-reload.ts) so a re-broadcast of the
   *  current root can't loop, and so the acting tab reloads only once. */
  activeRoot: 'forgeax.activeRoot',
} as const;

// Cross-component window CustomEvent names (NOT storage, but same "stringly-typed
// global namespace" footgun — centralized here so they can't drift either).
export const APP_EVENTS = {
  dockLayoutToggle: 'forgeax:shell:dock-layout-toggle',
  dockReset: 'forgeax:shell:dock-reset',
  animHandoff: 'forgeax:anim-handoff',
  /** Open (or focus, if already open) a dock panel by id. detail: { id: string } */
  openPanel: 'forgeax:shell:open-panel',
  /** Focus a dock panel by id ONLY if it already exists (no reopen / no force-insert). detail: { id: string } */
  focusPanel: 'forgeax:shell:focus-panel',
  /** Chat composer intercepted a send with no model path — open the connect
   *  prompt. detail: { text?: string } (the pending message, echoed back on
   *  resume so the composer can re-send it after the user connects). */
  openConnectPrompt: 'forgeax:open-connect-prompt',
  /** Connect prompt resolved with a usable model path — the composer that
   *  opened it should re-send the pending message. detail: { text?: string } */
  resumeSend: 'forgeax:resume-send',
  /** Onboarding milestones changed in the SAME session (tour finished, first
   *  chat done) — lets the chat empty-state hint react without a reload, since
   *  it can't re-read localStorage on its own. No detail. */
  onboardingChanged: 'forgeax:onboarding-changed',
} as const;
