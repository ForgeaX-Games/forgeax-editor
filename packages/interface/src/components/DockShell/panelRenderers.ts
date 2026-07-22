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
import type { SerializedDockview } from 'dockview';
import type { DockRegion } from './regions';
import type {
  PanelActionContribution,
  PanelContentDefinition,
  PanelHeaderDefinition,
} from '../../core/panels';

// Structural host-SDK boundary. Interface receives these factories from the
// aggregation host but must neither import nor type-resolve @forgeax/host-sdk:
// standalone editor intentionally has no such workspace dependency.
export interface ExtensionTransport {
  post(envelope: unknown): void;
  onMessage(handler: (envelope: unknown) => void): () => void;
  close(): void;
}

export interface ExtensionToolCall {
  toolId: string;
  args?: unknown;
  caller: {
    kind: 'user' | 'ai' | 'skill' | 'workbench' | 'cli';
    sessionId?: string;
    threadId?: string;
    agentId?: string;
  };
}

export type ExtensionToolResult =
  | { ok: true; result?: unknown }
  | { ok: false; error: string; code?: string };

export interface ExtensionPort {
  onChat(handler: (event: { text: string; attachments?: string[] }) => void): () => void;
  onToolCall(handler: (call: ExtensionToolCall) => Promise<ExtensionToolResult> | ExtensionToolResult): () => void;
  surface: {
    subscribe(handler: (event: {
      surfaceId: string;
      actions: Array<{ id: string; label?: string; args?: unknown; enabled: boolean; hotkey?: string }>;
      snapshot: unknown;
    }) => void): () => void;
  };
  setTheme(event: { locale?: 'zh' | 'en' | 'ja'; theme?: 'light' | 'dark' }): void;
  setVisibility(visible: boolean): void;
  onNavigate(handler: (event: { targetPluginId: string; payload?: Record<string, unknown> }) => void): () => void;
  close(): void;
}

export interface EditorContextMenuItem {
  label?: string;
  title?: string;
  icon?: string;
  shortcut?: string;
  forge?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  sep?: boolean;
  children?: EditorContextMenuItem[];
}

export interface CreateExtensionPortOptions {
  extensionId: string;
  transport: ExtensionTransport;
  initial?: {
    locale?: 'zh' | 'en' | 'ja';
    theme?: 'light' | 'dark';
    sessionId?: string;
    threadId?: string;
    pane?: 'left' | 'center';
  };
  defaultTimeoutMs?: number;
  onInvalid?: (raw: unknown, reason: string) => void;
}

// Factories are passed by an application host. Bivariant arguments retain the
// structural boundary while allowing a host to use narrower protocol-envelope
// types than interface needs to name.
type HostFactory<Options, Result> = {
  call(options: Options): Result;
}['call'];

export type CreateExtensionPort = HostFactory<CreateExtensionPortOptions, ExtensionPort>;

export interface WindowTransportOptions {
  target: Window;
  targetOrigin: string;
  expectedOrigin?: string;
  expectedSource?: () => Window | null;
  listenOn?: Window;
}

export type CreateWindowTransport = (options: WindowTransportOptions) => ExtensionTransport;

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
  /** Stable panel id. Optional during migration; DockPanelHost still passes the id. */
  id?: string;
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
  /** Optional shell-owned header metadata. */
  header?: PanelHeaderDefinition;
  /** Optional shell-owned content policy. */
  content?: PanelContentDefinition;
  /** Optional panel-scoped actions; normalized together with contributed actions. */
  actions?: readonly PanelActionContribution[];
  /** Dockview chrome behavior hints. DockRegion owns interpretation. */
  dockChrome?: {
    /** How to render this panel's dock tab when it is the only tab in its group. */
    singleTab?: 'default' | 'full' | 'hideTitle';
  };
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

  /** Single-realm editor coordination callbacks. Interface declares only the
   * structural contract; studio/standalone inject the editor-core implementation
   * so L1 never imports editor-core. */
  editor?: {
    setContextMenuRenderer?: (renderer: (menu: {
      x: number;
      y: number;
      items: EditorContextMenuItem[];
    } | null) => void) => () => void;
    installBridge?: (handlers: {
      onEditorHealth(entry: { level: 'info' | 'warn' | 'error'; code: string; message: string; ts: number }): void;
      onEditorConsole(entry: { level: 'log' | 'warn' | 'error' | 'info' | 'debug'; text: string; ts: number }): void;
      onEditorNetwork(entry: { kind: 'fetch' | 'xhr' | 'ws'; method: string; url: string; status: number; ms: number; ok: boolean; ts: number }): void;
      onEditorRef(payload:
        | { kind: 'entity'; id: number; name: string; components: string[]; source?: { plugin?: string; docId?: string } }
        | { kind: 'component'; entityId: number; entityName: string; comp: string; value: unknown }
        | { kind: 'asset'; guid: string; assetKind: string; name: string; packPath?: string }
      ): void;
      onAddAssetToChat(refs: Array<{
        type: 'asset' | 'folder';
        guid?: string;
        kind?: string;
        name: string;
        path: string;
        payload?: Record<string, unknown>;
        summary?: { totalAssets: number; kinds: Record<string, number>; guids: string[] };
      }>): void;
    }) => () => void;
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
    CornerAgentPicker?: ComponentType<{ preferredAgentExtensionId?: string }>;
  };

  /** Host-SDK factories for wb:* plugin iframe RPC (studio-only). The contract
   *  is structural so interface stays runnable without host-sdk installed. */
  hostSDK?: {
    createExtensionPort?: CreateExtensionPort;
    createWindowTransport?: CreateWindowTransport;
  };

  /** Live editor sub-panel ids (ep:*). The host derives this from its editor
   *  manifest; DockShell uses it to register panel renderers and menu entries.
   *  Empty means no editor is wired. */
  editorPanelIds: readonly string[];

  /** Optional host-owned layouts for built-in workbenches. Interface owns the
   *  docking mechanics but must not encode an editor application's panel
   *  arrangement, so editor hosts inject their Scene layout here. */
  builtinWorkbenchLayouts?: Readonly<Record<string, SerializedDockview>>;

  /** Inline (non-iframe) workbench panels, keyed by bus plugin id. Not a
   *  fixed slot — plugins register themselves here. Stays at top level. */
  workbenchPanels?: Record<string, () => ReactNode>;
}

// Interface-alone hosts do not expose editor panels. Editor hosts inject their
// own manifest through PanelRenderers.editorPanelIds.
export const DEFAULT_EDITOR_PANEL_IDS: readonly string[] = [];

export const DEFAULT_PANEL_RENDERERS: PanelRenderers = {
  editorPanelIds: DEFAULT_EDITOR_PANEL_IDS,
};

const PanelRenderersContext = createContext<PanelRenderers>(DEFAULT_PANEL_RENDERERS);

export const PanelRenderersProvider = PanelRenderersContext.Provider;

export function usePanelRenderers(): PanelRenderers {
  return useContext(PanelRenderersContext);
}
