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
// Type-only — erased at build. The runtime factories are INJECTED via
// PanelRenderers below so interface never statically pulls @forgeax/host-sdk
// into its module graph (it's a studio-only package; the standalone editor
// shell has no host-sdk and must still bundle interface). See B in the
// dependency-inversion refactor.
import type { createPluginPort, createWindowTransport } from '@forgeax/host-sdk';

export interface PanelRenderers {
  /** Editor sub-panel ids (ep:*). Empty when no editor is wired. */
  editorPanelIds: readonly string[];
  /** ep:* tab titles, keyed by panel id. */
  editorPanelTitles: Record<string, string>;
  /** Renders the edit surface (engine viewport). Omitted → placeholder. */
  renderEdit?: (opts: { viewportOnly?: boolean }) => ReactNode;
  /** Renders the play/preview surface. Omitted → placeholder. */
  renderPreview?: () => ReactNode;
  /**
   * Inline workbench panels (non-iframe React panels), keyed by bus plugin id.
   * The host (studio) injects concrete panels like wb-plugin-author; interface
   * itself holds NO specific plugin id and renders whatever is registered.
   * Omitted (standalone) → no inline panels, host falls back to the
   * iframe/placeholder branch. See A in the dependency-inversion refactor.
   */
  workbenchPanels?: Record<string, () => ReactNode>;
  /**
   * Host-SDK port factories for the studio-only wb:* plugin iframe RPC.
   * Injected so interface's StandalonePluginIframe can import these as TYPES
   * only — when absent (standalone), no plugin iframe RPC is wired (the
   * standalone shell never opens a wb:* plugin). See B.
   */
  createPluginPort?: typeof createPluginPort;
  createWindowTransport?: typeof createWindowTransport;
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
  editorPanelTitles: DEFAULT_EDITOR_PANEL_TITLES,
};

const PanelRenderersContext = createContext<PanelRenderers>(DEFAULT_PANEL_RENDERERS);

export const PanelRenderersProvider = PanelRenderersContext.Provider;

export function usePanelRenderers(): PanelRenderers {
  return useContext(PanelRenderersContext);
}
