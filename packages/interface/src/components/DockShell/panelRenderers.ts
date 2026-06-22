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
import { createContext, useContext, type ReactNode } from 'react';

export interface PanelRenderers {
  /** Editor sub-panel ids (ep:*). Empty when no editor is wired. */
  editorPanelIds: readonly string[];
  /** ep:* tab titles, keyed by panel id. */
  editorPanelTitles: Record<string, string>;
  /** Renders the edit surface (engine viewport). Omitted → placeholder. */
  renderEdit?: (opts: { viewportOnly?: boolean }) => ReactNode;
  /** Renders the play/preview surface. Omitted → placeholder. */
  renderPreview?: () => ReactNode;
}

// Default editor panel ids + titles. These are plain strings (NOT an import
// from any editor package) so interface stays self-contained and runnable on
// its own; studio overrides them with the real SSOT list via injection.
export const DEFAULT_EDITOR_PANEL_IDS: readonly string[] = [
  'hierarchy', 'assets', 'inspector', 'history',
  'capabilities', 'material', 'timeline', 'matgraph', 'launcher',
];

export const DEFAULT_EDITOR_PANEL_TITLES: Record<string, string> = {
  hierarchy: 'Hierarchy', assets: 'Assets', inspector: 'Inspector',
  history: 'History', capabilities: 'Capabilities',
  material: 'Material', timeline: 'Timeline', matgraph: 'Mat Graph',
  launcher: 'Launcher',
};

export const DEFAULT_PANEL_RENDERERS: PanelRenderers = {
  editorPanelIds: DEFAULT_EDITOR_PANEL_IDS,
  editorPanelTitles: DEFAULT_EDITOR_PANEL_TITLES,
};

const PanelRenderersContext = createContext<PanelRenderers>(DEFAULT_PANEL_RENDERERS);

export const PanelRenderersProvider = PanelRenderersContext.Provider;

export function usePanelRenderers(): PanelRenderers {
  return useContext(PanelRenderersContext);
}
