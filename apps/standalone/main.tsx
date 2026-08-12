// Standalone editor chrome entry — :15290 persistent shell.
//
// The shell and all business panels stay in this realm. Exactly one replaceable
// Viewport Runtime carrier owns Gateway, EditWorld, AssetRegistry and the GPU
// canvas under /editor/. Panels consume disposable projections over MessagePort;
// they never boot or mirror a second authoritative editor runtime. This same
// carrier boundary can later be hosted by a page or Tauri WebView without
// changing the Runtime contract.

import { StrictMode, useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@forgeax/interface/App';
import { type PanelDescriptor } from '@forgeax/interface/components/DockShell/panelRenderers';
// ADR 0025 M1: the shell is assembled through AppExtension manifests passed to
// <App overrides={{ extensions }}/> — the panelRenderers escape-hatch prop was
// removed in interface#112. panels-editor is interface's built-in factory for
// the ep:* dock panels + surfaces; the custom extension below carries the
// leftover fields (workbench layout seed + editor bridge hooks).
import type { AppExtension } from '@forgeax/interface/core/app-shell/types';
import { createPanelsEditorExtension } from '@forgeax/interface/core/extensions/panels-editor';
import { DEFAULT_EDITOR_DOCK_LAYOUT } from '@forgeax/editor/default-dock-layout';
import { configureWorkbenchClient, useShellStore } from '@forgeax/interface/store';
import { STORAGE_KEYS } from '@forgeax/interface/lib/storageKeys';
import { AppKitError } from '@forgeax/editor/app-kit';
import { EditorOverlayProvider } from '@forgeax/editor-ui/overlays';
// The viewport carrier is isolated; preview-only surfaces and business panels
// remain lightweight in-process components in the shell.
import { ViewportRuntimeFrame } from '@forgeax/editor-edit-runtime/runtime-frame';
import { ViewportComponent } from '@forgeax/editor-edit-runtime/viewport/viewport-component';
import { MaterialPreviewViewport } from '@forgeax/editor-edit-runtime/viewport/material-preview';
import { MeshPreviewViewport } from '@forgeax/editor-edit-runtime/viewport/mesh-preview';
import { VfxPreviewViewport } from '@forgeax/editor-edit-runtime/viewport/vfx-preview';
// editor-panels is not a direct root dependency (zero-transitive src/ design,
// AGENTS.md) — reach EDITOR_PANEL_COMPONENTS through the root package's own
// `./panels` export (-> packages/panels/src/manifest.ts), the same
// self-import pattern as `@forgeax/editor/app-kit` above.
import {
  EDITOR_PANEL_COMPONENTS,
  registerMaterialInstancePreview,
  registerMeshPreview,
  registerVfxPreview,
} from '@forgeax/editor/panels';
registerMaterialInstancePreview(MaterialPreviewViewport);
registerMeshPreview(MeshPreviewViewport);
registerVfxPreview(VfxPreviewViewport);
// EDITOR_PANELS id-list SSOT (editor-core manifest) — feeds v9 editorPanelIds
// + the panels registry keys, same source studio's editorRenderers uses.
import { EDITOR_PANELS } from '@forgeax/editor-core/manifest';
import {
  bindViewportRuntimeClient,
  forwardViewportRuntimeTransportRequest,
} from '@forgeax/editor-core';
import {
  createBroadcastViewportRuntimeClient,
  subscribeBroadcastViewportRuntimeReady,
  type MessagePortTransportClient,
  type ViewportRuntimeIdentity,
} from '@forgeax/editor/viewport-runtime';
import {
  createBrowserPanelPopupController,
  installPanelPopupClient,
  readPanelPopupIdentity,
  type PanelPopupEventTarget,
  type PanelPopupWindow,
} from '@forgeax/editor-product';
import { installInterfaceBridge, setContextMenuRenderer, createEditorPanelContributionsExtension, createEditorPageExtension } from '@forgeax/editor/bridge';
import '@forgeax/interface/styles/global.css';
import '@forgeax/editor-edit-runtime/theme.css';
import './standalone-chrome.css';
import './standalone-menu.css';
import {
  DeleteGuardDialogHost,
} from '@forgeax/editor-content-browser/delete-guard-entry';
import { DeleteGuardDialog } from './DeleteGuardDialog';

// keyboard-router convergence M4: the interface submodule's global-shortcuts
// router is editor-agnostic (lint:agnostic forbids importing @forgeax/editor),
// so we inject the editor-side callbacks it needs here — once, before React
// mounts (useGlobalShortcuts reads them at effect time). This keeps a SINGLE
// global keydown listener while routing the remaining Ctrl+D/G/viewport actions
// through the one gateway door.
import { registerKeyboardRouterDeps, type KeyboardRouterDeps } from '@forgeax/interface/lib/global-shortcuts';
import { decodeSurfaceFromLocation } from '@forgeax/interface/lib/platform';
import { DetachedSurface } from '@forgeax/interface/components/DetachedSurface';
import { PanelRenderersProvider } from '@forgeax/interface/components/DockShell/panelRenderers';
import { bootstrapAppHost } from '@forgeax/interface/appHostBootstrap';
import { HostProvider } from '@forgeax/interface/core/app-shell';
import { BrandProvider } from '@forgeax/interface/brand';
import { ErrorBoundary } from '@forgeax/interface/components/ErrorBoundary';
import { dispatchAction, registerAction } from '@forgeax/interface/lib/action-registry';
// keyboard-router deps builder is now shared (edit-runtime SSOT) so studio + this
// standalone host produce the SAME dep object — no divergence (the old inline copy
// here was silently missing from studio, killing its G/Esc keyboard path).
import { buildKeyboardRouterDeps } from '@forgeax/editor-edit-runtime/keyboard-router-deps';
import { projectViewportRuntimeOps } from '@forgeax/editor-edit-runtime/gateway-action-projection';
import { setPathResolver } from '@forgeax/editor-core';
import { isPanelVisible } from '@forgeax/interface/components/DockShell/DockRegion';
import { installSettingsPanelRedirect, SETTINGS_PANEL_ID } from './settings-redirect';
import { createStandaloneGameClient } from './game-service-client';

// Contextual F2/Delete/Mod+A have moved to focused widget scopes. This bridge
// remains only for shortcuts that have not yet migrated.
function makeKeyboardRouterDeps(): KeyboardRouterDeps {
  const deps = buildKeyboardRouterDeps() as KeyboardRouterDeps;
  return {
    ...deps,
    // The shell owns the one global shortcut listener, while the iframe Runtime
    // owns Gateway and document dirtiness. Reuse the Runtime-projected action;
    // never dispatch against the shell's inert editor-core singleton.
    save: () => {
      void dispatchAction(
        'saveDocToDisk',
        { requestId: `save-human-${crypto.randomUUID()}` },
        { source: 'human' },
      );
    },
  };
}

// Injected by vite `define` (vite.config.ts) from FORGEAX_GAME_DIR's basename.
// null when the stack was started without `cli.mjs run --game <dir>` — in that
// case no game is served and the editor opens on an empty scene.
declare const __FORGEAX_GAME_SLUG__: string | null;
declare const __FORGEAX_RUNTIME_BINDING__: import('@forgeax/engine-types').RuntimeAssetBinding | null;

// The standalone build is one game slot per host. A New Game submission
// materializes into that slot, then reloads the document so the compile-time
// engine/game-root wiring consumes the newly-created files on the next boot.
configureWorkbenchClient(createStandaloneGameClient(() => {
  window.setTimeout(() => window.location.reload(), 0);
}));

// ── shell panel injection + isolated Runtime carrier (PanelRenderers v9) ──────
// v9 (2026-07-08) reclassified PanelRenderers into structural category slots:
//   surfaces.SceneEditor — the one Viewport Runtime carrier. SurfaceKeepAliveLayer
//     mounts the iframe once above the dockview 'viewport' anchor.
//   panels — Record<bareId, PanelDescriptor>; DockPanelHost looks each ep:*
//     panel body up here. (replaces the pre-v9 `renderEditorPanel(id)`)
//   editorPanelIds — the ep:* id list DockShell registers (SSOT: editor-core
//     manifest). Its absence renders every editor panel as "Panel not mounted".
// Mirrors studio's editorRenderers.tsx (the v9 reference assembly), minus the
// studio-only chat/agents/overlays/detached/hostSDK slots.
const panelPopupListeners = new Map<string, Set<() => void>>();
const isPanelHostPage = window.location.pathname.startsWith('/panel-host');

function emitPanelPopupChanged(panelId: string): void {
  for (const listener of panelPopupListeners.get(panelId) ?? []) listener();
}

function subscribePanelPopup(panelId: string, listener: () => void): () => void {
  const listeners = panelPopupListeners.get(panelId) ?? new Set<() => void>();
  listeners.add(listener);
  panelPopupListeners.set(panelId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) panelPopupListeners.delete(panelId);
  };
}

function EditorPanelBody({ id }: { id: string }): ReactNode {
  const Comp = EDITOR_PANEL_COMPONENTS[id];
  const poppedOut = useSyncExternalStore(
    (listener) => subscribePanelPopup(id, listener),
    () => !isPanelHostPage && panelPopupController.isOpen(id),
    () => false,
  );
  if (poppedOut) {
    return (
      <div className="surface-placeholder" data-panel={id} data-panel-popup-active="1">
        <div className="surface-placeholder-title">{EDITOR_PANEL_TITLES[id] ?? id} is open in another window</div>
        <button type="button" onClick={() => panelPopupController.close(id)}>Dock back</button>
      </div>
    );
  }
  if (Comp) {
    return (
      <div style={{ position: 'relative', width: '100%', height: '100%' }}>
        {!isPanelHostPage && (
          <button
            type="button"
            data-testid={`panel-popup-${id}`}
            title={`Open ${EDITOR_PANEL_TITLES[id] ?? id} in a window`}
            style={{ position: 'absolute', top: 4, right: 4, zIndex: 20 }}
            onClick={() => {
              void panelPopupController.open(id, EDITOR_PANEL_TITLES[id] ?? id).then((result) => {
                if (result.ok) emitPanelPopupChanged(id);
              });
            }}
          >
            ⧉
          </button>
        )}
        <Comp />
      </div>
    );
  }
  return (
    <div className="surface-placeholder" data-panel={id} data-panel-unmounted="1">
      <div className="surface-placeholder-title">Panel not mounted</div>
    </div>
  );
}

// Tab labels for the dock panels. The id list remains EDITOR_PANELS; this map
// is host-owned display metadata used to fill PanelDescriptor.title.
const EDITOR_PANEL_TITLES: Record<string, string> = {
  hierarchy: 'Hierarchy', assets: 'Assets', inspector: 'Inspector',
  history: 'History', capabilities: 'Capabilities',
  launcher: 'Launcher', 'asset-overview': 'Asset Overview',
  'asset-properties': 'Properties', 'mesh-slots': 'Material Slots',
  'mesh-preview': 'Preview',
  'mat-preview': 'Preview', 'mi-preview': 'Preview', 'mi-properties': 'Properties',
  'vfx-system': 'System Outline', 'vfx-preview': 'Preview', 'vfx-timeline': 'Timeline',
  'vfx-details': 'Details', 'vfx-diagnostics': 'Diagnostics',
  settings: 'Settings',
};

const standalonePanels: Record<string, PanelDescriptor> = Object.fromEntries(
  EDITOR_PANELS.map((id, i) => [id, {
    title: EDITOR_PANEL_TITLES[id] ?? id,
    order: 100 + i,
    ...(id === 'hierarchy'
      ? { header: { visible: true, showTitle: false } }
      : {}),
    render: () => <EditorPanelBody id={id} />,
  }]),
);

// One replaceable carrier owns the authoritative Runtime realm. The shell keeps
// its dock/panels alive when this iframe reloads; game identity is injected into
// the edit-runtime build by the same fx process that starts this host.
const STANDALONE_VIEWPORT_RUNTIME = {
  version: 'viewport-runtime/v1',
  runtimeId: 'standalone-edit-runtime',
  runtimeGeneration: 1,
  carrierId: 'standalone-viewport',
  carrierKind: 'iframe',
} as const;

const panelPopupController = createBrowserPanelPopupController({
  eventTarget: window as unknown as PanelPopupEventTarget,
  origin: window.location.origin,
  runtime: STANDALONE_VIEWPORT_RUNTIME,
  openWindow: (url, name, features) => window.open(url, name, features) as unknown as PanelPopupWindow | null,
  createChannel: () => new MessageChannel(),
  forward: forwardViewportRuntimeTransportRequest,
  timeoutMs: 30_000,
  onClosed: emitPanelPopupChanged,
});

function StandaloneSceneEditor(_props: { viewportOnly?: boolean }): ReactNode {
  const detachedRuntime = new URLSearchParams(window.location.search).has('runtimeId');
  const disposeActionsRef = useRef<(() => void) | null>(null);
  const connectionRef = useRef<object | null>(null);
  const onClient = useCallback((client: unknown | null) => {
    disposeActionsRef.current?.();
    disposeActionsRef.current = null;
    const connection = client === null ? null : {};
    connectionRef.current = connection;
    if (connection === null) return;
    void projectViewportRuntimeOps(registerAction)
      .then((dispose) => {
        if (connectionRef.current !== connection) {
          dispose();
          return;
        }
        disposeActionsRef.current = dispose;
      })
      .catch((error) => console.warn('[viewport-runtime] capability projection unavailable', error));
  }, []);
  const onCapabilitiesChanged = useCallback(() => {
    if (connectionRef.current !== null) onClient(connectionRef.current);
  }, [onClient]);
  useEffect(() => () => {
    connectionRef.current = null;
    disposeActionsRef.current?.();
    disposeActionsRef.current = null;
  }, []);
  if (detachedRuntime) {
    return (
      <ViewportComponent
        gameSlug={__FORGEAX_GAME_SLUG__}
        gameRoot={__FORGEAX_GAME_SLUG__ ?? undefined}
        runtimeBinding={__FORGEAX_RUNTIME_BINDING__ ?? undefined}
      />
    );
  }
  return (
    <ViewportRuntimeFrame
      src="/editor/"
      runtime={STANDALONE_VIEWPORT_RUNTIME}
      onClient={onClient}
      onCapabilitiesChanged={onCapabilitiesChanged}
    />
  );
}

/** Keep the shell attached while the sole Runtime lives in a popup/Tauri page. */
function StandaloneViewportRuntimeWindowBridge(): ReactNode {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('runtimeId') && params.has('runtimeGeneration')) return;
    let client: MessagePortTransportClient | null = null;
    let unbind: (() => void) | null = null;
    let disposeActions: (() => void) | null = null;
    let currentKey: string | null = null;
    const disconnect = (): void => {
      disposeActions?.();
      disposeActions = null;
      unbind?.();
      unbind = null;
      client?.dispose();
      client = null;
      currentKey = null;
    };
    const connect = (runtime: ViewportRuntimeIdentity): void => {
      if (runtime.carrierKind !== 'browser-page' && runtime.carrierKind !== 'tauri-webview') return;
      const key = `${runtime.runtimeId}:${runtime.runtimeGeneration}:${runtime.carrierId}`;
      if (key === currentKey) return;
      disconnect();
      client = createBroadcastViewportRuntimeClient({ runtime });
      unbind = bindViewportRuntimeClient(runtime, client);
      currentKey = key;
      void projectViewportRuntimeOps(registerAction).then((dispose) => {
        if (currentKey === key) disposeActions = dispose;
        else dispose();
      });
    };
    const unsubscribe = subscribeBroadcastViewportRuntimeReady(connect);
    return () => {
      unsubscribe();
      disconnect();
    };
  }, []);
  return null;
}

/** Fields no interface factory covers: the workbench layout seed and the
 *  editor bridge hooks — one custom extension keeps them on the same
 *  contributePanels channel (mirrors studio's studio.editor-integration).
 *  setup() also installs the TopBar-gear redirect: the studio settings
 *  overlay does not exist in this host, so openOverlay('settings') is routed
 *  to the dockable Settings panel (apps/standalone/settings-redirect.ts). */
const standaloneEditorIntegrationExtension: AppExtension = {
  id: 'standalone.editor-integration', version: '1.0.0',
  requires: ['panels'],
  setup(ctx) {
    const disposePanels = ctx.contributePanels({
      builtinWorkbenchLayouts: { scene: DEFAULT_EDITOR_DOCK_LAYOUT },
      editor: {
        setContextMenuRenderer,
        installBridge: installInterfaceBridge,
      },
    });
    // The redirect needs the dock's live panel-visibility mirror so Ctrl+, /
    // the TopBar gear TOGGLES the ep:settings panel (open ↔ close) instead of
    // only ever re-opening it (the overlay store alone can't track a dock panel).
    const disposeRedirect = installSettingsPanelRedirect(
      useShellStore,
      ctx.bus,
      () => isPanelVisible(SETTINGS_PANEL_ID),
    );
    return () => {
      disposeRedirect();
      disposePanels();
    };
  },
};

/** Standalone shell assembly (ADR 0025 M1). No extension contributes a
 *  panels.chat descriptor, so the chat dock panel simply never exists here —
 *  the AC-09 "no chat/Forge in standalone" guarantee is now structural
 *  (formerly the hideChatAndForge prop). Module-scope const so <App>'s
 *  overrides prop stays referentially stable. */
const STANDALONE_OVERRIDES = {
  extensions: [
    createPanelsEditorExtension({
      editorPanelIds: [...EDITOR_PANELS],
      panels: standalonePanels,
      surfaces: { SceneEditor: StandaloneSceneEditor },
    }),
    createEditorPanelContributionsExtension(),
    createEditorPageExtension((id) => <EditorPanelBody id={id} />),
    standaloneEditorIntegrationExtension,
  ] as readonly AppExtension[],
} as const;

function boot(): void {
  const rootEl = document.getElementById('root');
  if (!rootEl) {
    // Charter P3 — explicit failure with a code AI users can branch on.
    throw new AppKitError({
      code: 'INVALID_ROOT_EL',
      hint: '#root element not present in apps/standalone/index.html',
      expected: '<div id="root"></div>',
    });
  }

  // Disk-tree projection is shell-owned and talks to the shell's same-origin
  // /api backend. This path mapper carries no Runtime state or AssetRegistry.
  setPathResolver((relativePath) => {
    const slug = __FORGEAX_GAME_SLUG__;
    if (!slug) return relativePath;
    return relativePath ? `${slug}/${relativePath}` : slug;
  });

  // Pin the active game BEFORE React mounts so UI surfaces (GameSwitcher label,
  // session scope) read the right slug. setPinnedSlug persists to localStorage.
  // Clearing when no --game guarantees a stale pin from a prior run can't mislabel
  // the shell. The engine boot itself gets the game via ViewportComponent props
  // (StandaloneSceneEditor), not this pin.
  try {
    useShellStore.getState().setPinnedSlug(__FORGEAX_GAME_SLUG__ ?? null);
  } catch {
    /* store/localStorage unavailable — fine; empty-scene path still works */
  }

  // Studio's first-run onboarding (welcome→project wizard: language pick +
  // connect-a-model) is a STUDIO product flow — the standalone editor has no
  // Forge/chat/model to connect, and during the welcome/project phases App
  // renders ONLY the onboarding wizard (the whole dock shell stays unmounted).
  // Seed the persisted state machine to 'done' BEFORE mount so the standalone
  // host always boots straight into the shell. Unconditional write = idempotent.
  try {
    localStorage.setItem(
      STORAGE_KEYS.onboarding,
      JSON.stringify({ v: 2, phase: 'done', done: { tour: true, firstChat: true } }),
    );
  } catch {
    /* localStorage unavailable — worst case the wizard shows; not fatal */
  }

  // Inject the editor-side keyboard-router callbacks (interface submodule stays
  // editor-agnostic). Must run before the App mounts so useGlobalShortcuts picks
  // them up at effect time.
  registerKeyboardRouterDeps(makeKeyboardRouterDeps());
  // Render the interface App directly — no hand-rolled StandaloneShell.
  // interface App.tsx already renders DockShell + SurfaceKeepAliveLayer +
  // ContextMenu (plan-strategy D-1: diff-set empty). The extension set injects
  // standalone's isolated Viewport Runtime + in-process editor panel slots;
  // chat/Forge never mount because nothing contributes them (AC-09, structural).
  try {
    createRoot(rootEl).render(
      <StrictMode>
        <App overrides={STANDALONE_OVERRIDES} />
      </StrictMode>,
    );
  } catch (err) {
    console.error('[standalone] React mount failed:', err);
    throw err;
  }

  // Mount keyboard delete guards above the dock chrome. Assets use the shared
  // Content Browser preflight; filesystem paths keep their irreversible warning.
  try {
    const guardEl = document.createElement('div');
    guardEl.id = 'delete-guard-root';
    document.body.appendChild(guardEl);
    createRoot(guardEl).render(
      <StrictMode>
        <DeleteGuardDialogHost />
        <DeleteGuardDialog />
      </StrictMode>,
    );
  } catch (err) {
    console.error('[standalone] DeleteGuardDialog mount failed:', err);
  }

  try {
    const overlayEl = document.createElement('div');
    overlayEl.id = 'editor-overlay-root';
    document.body.appendChild(overlayEl);
    createRoot(overlayEl).render(
      <StrictMode>
        <EditorOverlayProvider><StandaloneViewportRuntimeWindowBridge /></EditorOverlayProvider>
      </StrictMode>,
    );
  } catch (err) {
    console.error('[standalone] EditorOverlayProvider mount failed:', err);
  }
}

function bootPanelHost(): void {
  const identity = readPanelPopupIdentity(window.location.search);
  const opener = window.opener as unknown as PanelPopupWindow | null;
  if (identity === null || opener === null) {
    document.body.textContent = 'Panel popup handshake is unavailable.';
    return;
  }
  const disposeClient = installPanelPopupClient({
    eventTarget: window as unknown as PanelPopupEventTarget,
    opener,
    origin: new URL(window.location.search ? new URLSearchParams(window.location.search).get('hostOrigin') ?? window.location.origin : window.location.origin).origin,
    identity,
    onClient: (client) => {
      const unbind = bindViewportRuntimeClient(identity.runtime, client);
      window.addEventListener('beforeunload', unbind, { once: true });
    },
  });
  window.addEventListener('beforeunload', disposeClient, { once: true });
  const appRoot = document.getElementById('app') ?? document.body;
  createRoot(appRoot).render(
    <StrictMode>
      <EditorOverlayProvider>
        <EditorPanelBody id={identity.panelId} />
      </EditorOverlayProvider>
    </StrictMode>,
  );
}

function bootDetachedSurface(): void {
  const surface = decodeSurfaceFromLocation();
  if (surface === null) return;
  registerKeyboardRouterDeps(makeKeyboardRouterDeps());
  const appRoot = document.getElementById('app') ?? document.body;
  void bootstrapAppHost(STANDALONE_OVERRIDES).then(({ host }) => {
    createRoot(appRoot).render(
      <StrictMode>
        <ErrorBoundary scope="detached-surface">
          <BrandProvider>
            <HostProvider value={host}>
              <PanelRenderersProvider value={host.panels}>
                <EditorOverlayProvider>
                  <DetachedSurface surface={surface} />
                </EditorOverlayProvider>
              </PanelRenderersProvider>
            </HostProvider>
          </BrandProvider>
        </ErrorBoundary>
      </StrictMode>,
    );
  });
}

if (isPanelHostPage) bootPanelHost();
else if (decodeSurfaceFromLocation() !== null) bootDetachedSurface();
else boot();
