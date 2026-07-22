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
import { FilesPanel } from '../Sidebar/FilesPanel';
import { ConsolePanel } from '../MainArea/ConsolePanel';
import { TelemetryViewer } from '../MainArea/TelemetryViewer';
import { InfoPanel } from '../StatusBar/InfoPanel';
import { RecoveryBoundary } from '../ErrorBoundary';
// Editor panel bodies resolve through the runtime PanelRenderers context so
// interface stays editor-agnostic (no `@forgeax/editor*` import).
import { usePanelRenderers } from './panelRenderers';
import { DockPanelHost } from './DockPanelHost';

// Agents panel body — injected by studio from `@forgeax/ai-workbench`.
// When absent (interface-alone / standalone editor) render a neutral placeholder
// so the dock/pop-out slot stays valid. Exported so Sidebar can reuse the same
// placeholder path (consistent UX between dock-panel and sidebar mount).
export function AgentsPanelSlot(): ReactNode {
  const SidebarAgents = usePanelRenderers().slots?.SidebarAgents;
  if (SidebarAgents) return <div data-fx-slot="SidebarAgents" style={{ display: 'contents' }}><SidebarAgents /></div>;
  return (
    <div className="surface-placeholder">
      <div className="surface-placeholder-title">No agents app configured</div>
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
  /** Stable `data-tour-id` for the onboarding TourOverlay to anchor a coach
   *  mark on this panel's live body. Omitted → not a tour target. */
  tourId?: string;
}

// ── core + optional panels ───────────────────────────────────────────────────
// Order within each array is the order the layout menu lists them.
export const CORE_PANELS: PanelDef[] = [
  { id: 'tools', title: 'Tools', group: 'core', canPopOut: true, tourId: 'sidebar', render: () => <Sidebar /> },
  // 'main' is the plugin-launcher / catalog panel (formerly titled 'Workbench',
  // which was redundant with the top-level workbench tab strip). It renders MainArea.
  { id: 'main', title: 'Studio', group: 'core', canPopOut: true, render: () => <MainArea /> },
  // In flat-architecture mode 'viewport' is the combined panel (engine canvas +
  // gizmo). Its body is contributed via panels.viewport, same as chat/ep:*
  // panels; the descriptor renders the anchor tracked by SurfaceKeepAliveLayer.
  { id: 'viewport', title: 'Viewport', group: 'core', canPopOut: true, tourId: 'preview', render: () => <DockPanelHost id="viewport" /> },
  // R4: chat body comes from the studio-injected panels['chat'] registry.
  { id: 'chat', title: 'ForgeaX CLI', group: 'core', canPopOut: true, tourId: 'chat', render: () => <DockPanelHost id="chat" /> },
];

export const OPTIONAL_PANELS: PanelDef[] = [
  { id: 'agents', title: 'Agents', group: 'optional', canPopOut: true, render: () => <DockPanelHost id="agents" /> },
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

// ── derived lookup maps (DockShell consumes these; never edit by hand) ────────
const ALL_PANELS = [...CORE_PANELS, ...OPTIONAL_PANELS];

/** Wrap a panel renderer in a region-scoped RecoveryBoundary so a render throw
 *  in ONE dock panel (a bad selector, a plugin panel) shows a retry/reload
 *  affordance for that panel only — instead of taking down the whole shell. The
 *  inline (non-fullscreen) variant keeps the surrounding dock layout intact. */
function withBoundary(scope: string, render: () => ReactNode): () => ReactNode {
  return () => <RecoveryBoundary scope={scope} fullscreen={false}>{render()}</RecoveryBoundary>;
}

// Tour anchors for editor (`ep:*`) panels. The default 'edit' workspace has no
// workbench 'sidebar' panel — its left column is the Hierarchy panel — so the
// first tour step ('sidebar') anchors here instead. Same id as CORE workbench
// so whichever left panel a workspace mounts gets highlighted.
const EP_TOUR_IDS: Record<string, string | undefined> = {
  hierarchy: 'sidebar',
};

function tourWrap(tourId: string | undefined, render: () => ReactNode): () => ReactNode {
  if (!tourId) return render;
  // Layout-neutral tour anchor: render the panel body UNCHANGED (no wrapper in
  // the flow) and append an out-of-flow, zero-size marker. The TourOverlay reads
  // the marker's PARENT rect (the dockview content box = the panel's real area),
  // so highlighting never perturbs the panel's own layout.
  return () => (
    <>
      {render()}
      <span
        data-tour-id={tourId}
        data-tour-anchor-parent="1"
        aria-hidden="true"
        style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}
      />
    </>
  );
}


/** Static, interface-owned dockview component map. Host-owned editor panels
 *  are added at runtime by buildEditorPanelComponents(). */
export const BASE_PANEL_COMPONENTS: Record<string, (props: IDockviewPanelProps) => ReactNode> =
  Object.fromEntries(ALL_PANELS.map((p) => [
    p.id,
    withBoundary(`panel:${p.id}`, tourWrap(p.tourId, p.render)),
  ]));

/** Static titles for interface-owned panels only. */
export const BASE_PANEL_TITLE: Record<string, string> =
  Object.fromEntries(ALL_PANELS.map((p) => [p.id, p.title]));

/** Runtime editor panel component map. The host injects the bare ids from its
 *  editor manifest, so the interface never owns a business panel list. */
export function buildEditorPanelComponents(
  editorPanelIds: readonly string[],
): Record<string, (props: IDockviewPanelProps) => ReactNode> {
  return Object.fromEntries(editorPanelIds.map((id) => [
    `ep:${id}`,
    withBoundary(`ep:${id}`, tourWrap(EP_TOUR_IDS[id], () => <DockPanelHost id={id} />)),
  ]));
}

/** Core panel ids offered in the layout menu's main-panels section (excludes 'main' alias). */
export const CORE_PANEL_IDS = ['tools', 'viewport', 'chat'] as const;
/** Optional panel ids (layout menu more-panels section). */
export const OPTIONAL_PANEL_IDS = OPTIONAL_PANELS.map((p) => p.id) as readonly string[];
/** Panels that can pop out into a real OS window. */
export const SURFACE_PANEL_IDS = new Set(ALL_PANELS.filter((p) => p.canPopOut).map((p) => p.id));
