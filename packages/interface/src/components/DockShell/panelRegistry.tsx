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
import { PreviewPanel } from '../MainArea/SurfacePanels';
import { EditPanel } from '../MainArea/SurfacePanels';
import { ChatPanel } from '../ChatPanel/ChatPanel';
import { AgentsPanel } from '../Sidebar/AgentsPanel';
import { FilesPanel } from '../Sidebar/FilesPanel';
import { ConsolePanel } from '../MainArea/ConsolePanel';
import { EditorPanelFrame, type EditorPanelId } from './EditorPanelFrame';
// Editor panel ids (ep:*) are injected at runtime via PanelRenderers context
// so interface stays editor-agnostic (no `@forgeax/editor*` import). The
// DEFAULT_* list here is the neutral fallback for interface-alone; studio
// overrides it with the editor-shared SSOT through the context provider.
import { DEFAULT_EDITOR_PANEL_IDS, DEFAULT_EDITOR_PANEL_TITLES } from './panelRenderers';

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
  { id: 'preview', title: 'Preview', group: 'core', canPopOut: true, render: () => <PreviewPanel /> },
  // In flat-architecture mode 'edit' is a VIEWPORT-only panel (engine canvas +
  // gizmo); the editor's React sub-panels live as ep:* panels.
  { id: 'edit', title: 'Edit', group: 'core', canPopOut: true, render: () => <EditPanel viewportOnly /> },
  { id: 'chat', title: 'ForgeaX CLI', group: 'core', canPopOut: true, render: () => <ChatPanel /> },
];

export const OPTIONAL_PANELS: PanelDef[] = [
  { id: 'agents', title: 'Agents', group: 'optional', canPopOut: true, render: () => <AgentsPanel /> },
  { id: 'files', title: 'Files', group: 'optional', canPopOut: true, render: () => <FilesPanel /> },
  { id: 'console', title: 'Console', group: 'optional', canPopOut: true, render: () => <ConsolePanel /> },
];

// ── editor panel family (ep:*) ───────────────────────────────────────────────
// Each renders an iframe to /editor/?panel=<id> connected via BroadcastChannel.
// The default id list lives in ./panelRenderers (a plain string list, NOT an
// editor-package import) so interface is self-contained; studio injects the
// real editor-shared SSOT through PanelRenderers context. These module-level
// exports are the interface-alone fallback used by buildDefault.
export const EDITOR_PANEL_IDS: EditorPanelId[] = [...DEFAULT_EDITOR_PANEL_IDS] as EditorPanelId[];
export const EDITOR_PANEL_TITLE: Record<string, string> = DEFAULT_EDITOR_PANEL_TITLES;

// ── derived lookup maps (DockShell consumes these; never edit by hand) ────────
const ALL_PANELS = [...CORE_PANELS, ...OPTIONAL_PANELS];

/** dockview component map: id → renderer (incl. ep:* editor panels). The
 *  wb:<pluginId> dynamic plugin renderers are merged in by DockShell at runtime. */
export const PANEL_COMPONENTS: Record<string, (props: IDockviewPanelProps) => ReactNode> = {
  ...Object.fromEntries(ALL_PANELS.map((p) => [p.id, p.render])),
  ...Object.fromEntries(EDITOR_PANEL_IDS.map((id) => [`ep:${id}`, () => <EditorPanelFrame panelId={id} />])),
};

/** id → title (incl. ep:* editor panels). */
export const PANEL_TITLE: Record<string, string> = {
  ...Object.fromEntries(ALL_PANELS.map((p) => [p.id, p.title])),
  ...Object.fromEntries(EDITOR_PANEL_IDS.map((id) => [`ep:${id}`, EDITOR_PANEL_TITLE[id]])),
};

/** Core panel ids offered in the layout menu's main-panels section (excludes 'main' alias). */
export const CORE_PANEL_IDS = ['workbench', 'preview', 'edit', 'chat'] as const;
/** Optional panel ids (layout menu more-panels section). */
export const OPTIONAL_PANEL_IDS = OPTIONAL_PANELS.map((p) => p.id) as readonly string[];
/** Panels that can pop out into a real OS window. */
export const SURFACE_PANEL_IDS = new Set(ALL_PANELS.filter((p) => p.canPopOut).map((p) => p.id));
