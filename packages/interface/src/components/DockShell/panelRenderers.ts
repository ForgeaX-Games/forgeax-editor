// Panel renderer injection — keeps the interface shell business-agnostic.
//
// The DockShell renders generic chrome (workbench / preview / edit / chat /
// ep:* editor panels), but the actual edit & preview SURFACES belong to an
// app (today: the editor). To avoid interface importing `@forgeax/editor*`
// (which created the studio → interface → editor → interface cycle), the
// host injects the editor-specific render slots through this context.
//
// - interface ALONE renders neutral placeholders (no editor present).
// - studio injects real renderers built from `@forgeax/editor/{edit,play}`.
//
// This is the same shape as the existing `wb:*` plugin merge: DockShell owns
// the docking mechanics, the host supplies the panel bodies.
import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
// Type-only — erased at build. The runtime factories are INJECTED via
// PanelRenderers below so interface never statically pulls @forgeax/host-sdk
// into its module graph (it's a studio-only package; the standalone editor
// shell has no host-sdk and must still bundle interface). See B in the
// dependency-inversion refactor.
import type { createPluginPort, createWindowTransport } from '@forgeax/host-sdk';
import type { DockRegion } from './regions';

/**
 * A dock panel descriptor. Carries everything the DockRegion needs to know
 * to render a panel: title (tab label), optional visual/behavior hints
 * (order/icon/when/defaultRegion), and the body renderer.
 *
 * Phase 1 uses `defaultRegion` as the initial home; user overrides live in
 * the active workbench's `panelLocations` (see useActiveWorkbench). Phase 2
 * wires the override via UI.
 */
export interface PanelDescriptor {
  /** Tab label shown on the dock tab. */
  title: string;
  /** Sort order within the region. Lower = earlier. Default 0. */
  order?: number;
  /** Reserved for Phase 2 activity-bar icon. Ignored today. */
  icon?: string;
  /** Predicate for conditional visibility. Missing = always visible. */
  when?: () => boolean;
  /** Where this panel lives absent a user override. Default 'DockShell'. */
  defaultRegion?: DockRegion;
  /** Panel body renderer. */
  render: () => ReactNode;
}

/**
 * Structural slot registry for the interface shell.
 *
 * Categories reflect where in the shell each slot lives — this is the SSOT
 * for the compositional design so future maintainers can find "where should
 * I put this new injection" by role, not by naming coincidence.
 *
 *   panels    — draggable dockview panel bodies (user-arrangeable)
 *   overlays  — full-screen modal-style layers
 *   surfaces  — heavy engine viewports (kept alive above dockview)
 *   chrome    — fixed shell regions outside dockview
 *   detached  — bodies of DETACHED OS windows (Tauri or `window.open`)
 *   slots     — well-defined sub-slots inside interface-owned components
 *   hostSDK   — capability factories (not rendering)
 *
 * All render targets are React Components (capitalized nouns) — consumers
 * use JSX `<X.Y />` directly, no render-function-call syntax.
 *
 * (v9 · 2026-07-08) The former `workbench` category — a feature-name grouping
 * mixing MainArea body / sidebar sub-nav / detached windows — was eliminated.
 * Its five slots are now reclassified by structural role into `detached.*`
 * and `slots.*`. Structural categories no longer contain feature names.
 */
export interface PanelRenderers {
  /** Draggable dock panels (dockview body injection).
   *  Consumers mount via `<DockPanelHost id={id}/>` which looks each id up here. */
  panels?: Record<string, PanelDescriptor>;

  /** Full-screen overlays (modals, dashboards). Positioned above dockview + chrome. */
  overlays?: {
    Dashboard?: ComponentType;
    Settings?: ComponentType;
  };

  /** Heavy engine surfaces. Positioned by SurfaceKeepAliveLayer above the
   *  dockview 'viewport' panel anchor, so they survive dockview rebuilds.
   *
   *  2026-06-30: preview/edit merged into a single 'viewport' panel; the old
   *  `Preview` slot was retired. `SceneEditor` is now the only engine surface
   *  — a WYSIWYG viewport that switches between edit-time gizmos and play-time
   *  simulation on the same in-process engine. Future play/debug modes would
   *  add sibling slots here. */
  surfaces?: {
    SceneEditor?: ComponentType<{ viewportOnly?: boolean }>;
  };

  /** Fixed shell chrome regions (outside dockview). */
  chrome?: {
    /** Items injected into the bottom StatusBar (pulse feeds, version badge). */
    StatusFeeds?: ComponentType;
  };

  /** Bodies of DETACHED OS-windows (Tauri or `window.open`) keyed by surface id.
   *  Rendered inside <DetachedSurface> when a panel/surface is popped out.
   *  Same host bundle loads with `?surface=...` in the URL; DetachedSurface
   *  reads these slots to mount the correct body. */
  detached?: {
    AgentsBrowser?: ComponentType;
    FilesBrowser?: ComponentType;
  };

  /** Sub-slot injection points — each is a well-defined callsite inside an
   *  interface-owned component where studio fills in feature-specific content.
   *  Each slot has ONE render callsite.
   *
   *  Leaf names are globally unique on purpose — DOM slot markers use the
   *  bare leaf name (data-fx-slot="MainAreaBody") without a "slots:" prefix. */
  slots?: {
    /** MainArea body when app mode is not the SceneEditor mode (i.e., 'ai'). */
    MainAreaBody?: ComponentType;
    /** Sidebar's Agents sub-nav body. */
    SidebarAgents?: ComponentType;
    /** Plugin-host top-right widget (in MainArea when a wb:* plugin is expanded). */
    CornerAgentPicker?: ComponentType<{ preferredAgentPluginId?: string }>;
  };

  /** Host-SDK factories for wb:* plugin iframe RPC (studio-only). Injected as
   *  types-only from interface (no runtime host-sdk import in L1). */
  hostSDK?: {
    createPluginPort?: typeof createPluginPort;
    createWindowTransport?: typeof createWindowTransport;
  };

  /** Editor sub-panel ids (ep:*). Empty when no editor is wired. Stays at the
   *  top level because it's a plain data list, not a component slot. */
  editorPanelIds: readonly string[];

  /** Inline (non-iframe) workbench panels, keyed by bus plugin id. Not a
   *  fixed slot — plugins register themselves here. Stays at top level. */
  workbenchPanels?: Record<string, () => ReactNode>;
}

// Default editor panel ids + titles. These are plain strings (NOT an import
// from any editor package) so interface stays self-contained and runnable on
// its own; studio overrides them with the real SSOT list via injection.
export const DEFAULT_EDITOR_PANEL_IDS: readonly string[] = [
  'hierarchy', 'assets', 'inspector', 'history',
  'capabilities', 'material', 'mesh', 'timeline', 'matgraph', 'launcher',
  'asset-inspector',
];

export const DEFAULT_EDITOR_PANEL_TITLES: Record<string, string> = {
  hierarchy: 'Hierarchy', assets: 'Assets', inspector: 'Inspector',
  history: 'History', capabilities: 'Capabilities',
  material: 'Material', mesh: 'Mesh', timeline: 'Timeline', matgraph: 'Mat Graph',
  launcher: 'Launcher', 'asset-inspector': 'Asset Inspector',
};

export const DEFAULT_PANEL_RENDERERS: PanelRenderers = {
  editorPanelIds: DEFAULT_EDITOR_PANEL_IDS,
};

const PanelRenderersContext = createContext<PanelRenderers>(DEFAULT_PANEL_RENDERERS);

export const PanelRenderersProvider = PanelRenderersContext.Provider;

export function usePanelRenderers(): PanelRenderers {
  return useContext(PanelRenderersContext);
}
