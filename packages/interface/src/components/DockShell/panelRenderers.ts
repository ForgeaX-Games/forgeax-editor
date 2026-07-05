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
   * Renders a single editor panel (ep:*) by its id. Injected by the host
   * (standalone / studio) so interface never statically imports editor
   * panel components (DIP zero-cycle paradigm, same as renderEdit/renderChat).
   * Omitted (interface-alone) -> the ep:* panel shows a neutral placeholder.
   *
   * plan-strategy section 2 D4 (M2 injection slot); interface holds NO editor/
   * engine import -- the slot's id is a plain string, matching the existing
   * `editorPanelIds: readonly string[]` convention.
   */
  renderEditorPanel?: (id: string) => ReactNode;
  /**
   * Renders the chat surface (the Forge conversation UI). Injected by studio
   * from `@forgeax/chat` (R4 — chat is a 前L2 app composed into the shell, not
   * an interface import). Omitted (interface-alone / standalone editor) → the
   * chat panel renders a neutral placeholder. interface holds NO `@forgeax/chat`
   * import; the body comes through this slot exactly like renderEdit/renderPreview.
   */
  renderChat?: () => ReactNode;
  /**
   * Renders the dashboard overlay (Overview / Sessions / Analytics). Injected
   * by studio from `@forgeax/dashboard` (R4 — dashboard is a 前L2 app composed
   * into the shell). Its DATA (sessions / telemetry) stays in interface's L1
   * store; this slot only supplies the body. Omitted → no overlay (interface
   * holds NO `@forgeax/dashboard` import).
   */
  renderDashboard?: () => ReactNode;
  /**
   * Renders the settings overlay (the unified settings panel + its sections
   * register side-effect). Injected by studio from `@forgeax/settings` (R4).
   * Its DATA (settingsOpen / settingsSection) stays in interface's L1 store;
   * this slot supplies the body. Omitted → no overlay (interface holds NO
   * `@forgeax/settings` import).
   */
  renderSettings?: () => ReactNode;
  /**
   * Renders the workbench main-area surface (R4 — injected by studio from
   * `@forgeax/workbench`). The variant selects which entrypoint:
   *  - 'full'   → the workbenchTab router (WorkbenchMode), used by MainArea.
   *  - 'agents' → the agents browser (AgentsMainArea), detached 'agents' window.
   *  - 'files'  → the file workbench with the empty-gallery suppressed
   *               (WorkbenchModeDefault showGalleryWhenEmpty={false}), detached
   *               'files' window.
   * The workbench DATA + the plugin-HOSTING runtime (WorkbenchPluginHost,
   * keep-alive iframes, CenterPluginLayer, wb:* dock panels, host-sdk RPC) stay
   * in interface (L1 shell infrastructure); this slot supplies only the
   * navigation/gallery UI body. Omitted (interface-alone) → placeholder.
   */
  renderWorkbench?: (variant: 'full' | 'agents' | 'files') => ReactNode;
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
