// Panel registry — the single declarative source for dockview panels.
//
// Background (architecture review §C1): adding a panel used to mean editing 6
// scattered constants in DockShell.tsx (BASE_COMPONENTS, PANEL_TITLE, PANEL_IDS,
// OPTIONAL_IDS, EDITOR_PANEL_IDS, SURFACE_PANELS) — miss one and the panel
// silently half-works (no title / can't pop out / missing from the layout menu).
//
// Now you add ONE PanelDef here. Every lookup map DockShell needs is derived
// from this list. (This mirrors the declarative `useSurface` registration that
// the review flagged as the codebase's gold-standard extension point.)
import type { ReactNode } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { Sidebar } from '../Sidebar/Sidebar';
import { MainArea } from '../MainArea/MainArea';
import { ViewportPanel } from '../MainArea/SurfacePanels';
import { AgentsPanel } from '../Sidebar/AgentsPanel';
import { FilesPanel } from '../Sidebar/FilesPanel';
import { ConsolePanel } from '../MainArea/ConsolePanel';
import { TelemetryViewer } from '../MainArea/TelemetryViewer';
import { InfoPanel } from '../StatusBar/InfoPanel';
import { RecoveryBoundary } from '../ErrorBoundary';
// Editor panel ids (ep:*) are injected at runtime via PanelRenderers context
// so interface stays editor-agnostic (no `@forgeax/editor*` import). The
// DEFAULT_* list here is the neutral fallback for interface-alone; studio
// overrides it with the editor-shared SSOT through the context provider.
import { DEFAULT_EDITOR_PANEL_IDS, DEFAULT_EDITOR_PANEL_TITLES, usePanelRenderers } from './panelRenderers';

// Chat panel body comes from the injected `renderChat` slot (R4: chat is a
// 前L2 @forgeax/chat app, NOT an interface import). studio injects it; when
// absent (interface-alone / standalone editor) we render a neutral placeholder
// so the dock slot stays valid. Mirrors the renderEdit/renderPreview seam.
function ChatPanelSlot(): ReactNode {
  const { renderChat } = usePanelRenderers();
  if (renderChat) return renderChat();
  return (
    <div className="surface-placeholder">
      <div className="surface-placeholder-title">No chat app configured</div>
    </div>
  );
}

export interface PanelDef {
  /** dockview panel id + component key (must be unique). */
  id: string;
  /** Tab title. */
  title: string;
  /** Renderer. */
  render: () => ReactNode;
  /** Layout-menu grouping. 'core' = the main panels (always offered);
   *  'optional' = off by default, toggled from the layout menu. Editor (ep:*)
   *  panels are registered separately via the EDITOR_PANELS family below. */
  group: 'core' | 'optional';
  /** Can pop out into a real OS window (DetachedSurface). */
  canPopOut?: boolean;
}

// ── core + optional panels ───────────────────────────────────────────────────
// Order within each array is the order the layout menu lists them.
export const CORE_PANELS: PanelDef[] = [
  { id: 'workbench', title: 'Tools', group: 'core', canPopOut: true, render: () => <Sidebar /> },
  // 'main' is a backward-compat alias kept for saved layouts (renders MainArea).
  { id: 'main', title: 'Workbench', group: 'core', canPopOut: true, render: () => <MainArea /> },
  // In flat-architecture mode 'viewport' is the combined panel (engine canvas +
  // gizmo); the editor's React sub-panels live as ep:* panels.
  // 2026-06-30: 'preview'/'edit' merged into single 'viewport' panel.
  { id: 'viewport', title: 'Viewport', group: 'core', canPopOut: true, render: () => <ViewportPanel /> },
  // R4: chat body comes from the injected renderChat slot (ChatPanelSlot).
  { id: 'chat', title: 'ForgeaX CLI', group: 'core', canPopOut: true, render: () => <ChatPanelSlot /> },
];

export const OPTIONAL_PANELS: PanelDef[] = [
  { id: 'agents', title: 'Agents', group: 'optional', canPopOut: true, render: () => <AgentsPanel /> },
  { id: 'files', title: 'Files', group: 'optional', canPopOut: true, render: () => <FilesPanel /> },
  { id: 'console', title: 'Console', group: 'optional', canPopOut: true, render: () => <ConsolePanel /> },
  // Observability (trace + log) feed — trace waterfall + log stream, fed by the
  // unified store.telemetry slice (node WS `{type:'telemetry'}` + iframe
  // `VAG_TELEMETRY`). See MainArea/TelemetryViewer.tsx.
  { id: 'telemetry', title: 'Telemetry', group: 'optional', canPopOut: true, render: () => <TelemetryViewer /> },
  // Blender-INFO-style health/log feed — the same store the bottom HealthStatusBar
  // peeks at, full-height with click-to-copy + repeat-fold (×N).
  { id: 'info', title: 'Info', group: 'optional', canPopOut: true, render: () => <InfoPanel /> },
];

// ── editor panel family (ep:*) ───────────────────────────────────────────────
// Each panel renders as an in-process React component via the injected
// renderEditorPanel slot (single-realm M2). The default id list lives in
// ./panelRenderers (a plain string list, NOT an editor-package import) so
// interface is self-contained; studio injects the real editor SSOT through
// PanelRenderers context. These module-level exports are the interface-alone
// fallback used by buildDefault.
export const EDITOR_PANEL_IDS: string[] = [...DEFAULT_EDITOR_PANEL_IDS] as string[];
export const EDITOR_PANEL_TITLE: Record<string, string> = DEFAULT_EDITOR_PANEL_TITLES;

// ── derived lookup maps (DockShell consumes these; never edit by hand) ────────
const ALL_PANELS = [...CORE_PANELS, ...OPTIONAL_PANELS];

/** Wrap a panel renderer in a region-scoped RecoveryBoundary so a render throw
 *  in ONE dock panel (a bad selector, a plugin panel) shows a retry/reload
 *  affordance for that panel only — instead of taking down the whole shell. The
 *  inline (non-fullscreen) variant keeps the surrounding dock layout intact. */
function withBoundary(scope: string, render: () => ReactNode): () => ReactNode {
  return () => <RecoveryBoundary scope={scope} fullscreen={false}>{render()}</RecoveryBoundary>;
}

/** Editor panel body — resolved from the injected renderEditorPanel slot
 *  (single-realm M2: the host injects EDITOR_PANEL_COMPONENTS[id] as an
 *  in-process React component). Falls back to a neutral "panel not mounted"
 *  placeholder when no host is wired (interface-alone) or the id has no
 *  registered component (D6: timeline / matgraph / systems drift ids).
 *  EditorPanelFrame.tsx (pre-M2 iframe panel shell) was deleted in M4.
 *  withBoundary (E1) still wraps it so a render throw in one panel doesn't
 *  take down the host.
 *  Anchors: plan-strategy S2 D6 / S4 R5; requirements AC-04/AC-05, edge E1. */
function EditorPanelSlot({ id }: { id: string }): ReactNode {
  const { renderEditorPanel } = usePanelRenderers();
  const body = renderEditorPanel?.(id);
  if (body !== undefined && body !== null) return body;
  return (
    <div className="surface-placeholder" data-panel={id} data-panel-unmounted="1">
      <div className="surface-placeholder-title">Panel not mounted</div>
    </div>
  );
}

/** dockview component map: id → renderer (incl. ep:* editor panels). The
 *  wb:<pluginId> dynamic plugin renderers are merged in by DockShell at runtime. */
export const PANEL_COMPONENTS: Record<string, (props: IDockviewPanelProps) => ReactNode> = {
  ...Object.fromEntries(ALL_PANELS.map((p) => [p.id, withBoundary(`panel:${p.id}`, p.render)])),
  ...Object.fromEntries(EDITOR_PANEL_IDS.map((id) => [`ep:${id}`, withBoundary(`ep:${id}`, () => <EditorPanelSlot id={id} />)])),
};

/** id → title (incl. ep:* editor panels). */
export const PANEL_TITLE: Record<string, string> = {
  ...Object.fromEntries(ALL_PANELS.map((p) => [p.id, p.title])),
  ...Object.fromEntries(EDITOR_PANEL_IDS.map((id) => [`ep:${id}`, EDITOR_PANEL_TITLE[id]])),
};

/** Core panel ids offered in the layout menu's main-panels section (excludes 'main' alias). */
export const CORE_PANEL_IDS = ['workbench', 'viewport', 'chat'] as const;
/** Optional panel ids (layout menu more-panels section). */
export const OPTIONAL_PANEL_IDS = OPTIONAL_PANELS.map((p) => p.id) as readonly string[];
/** Panels that can pop out into a real OS window. */
export const SURFACE_PANEL_IDS = new Set(ALL_PANELS.filter((p) => p.canPopOut).map((p) => p.id));
