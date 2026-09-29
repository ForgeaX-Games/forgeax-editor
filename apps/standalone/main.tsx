// Standalone editor chrome entry — :15290 persistent shell.
//
// The shell and all business panels stay in this realm. Exactly one replaceable
// Viewport Runtime carrier owns Gateway, EditWorld, AssetRegistry and the GPU
// canvas under /editor/. Panels consume disposable projections over MessagePort;
// they never boot or mirror a second authoritative editor runtime. This same
// carrier boundary can later be hosted by a page or Tauri WebView without
// changing the Runtime contract.

import '@forgeax/interface/styles/global.css';
import { StrictMode, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApplicationDetachedShell, ApplicationShell } from '@forgeax/interface/ApplicationShell';
import { useTranslation } from '@forgeax/editor-core/i18n';
// ADR 0025 M1: the shell is assembled through AppExtension manifests passed to
// the public application runtime — the panelRenderers escape-hatch prop was
// removed in interface#112. panels-editor is interface's built-in factory for
// the ep:* dock panels + surfaces; the custom extension below carries the
// remaining fields (built-in Page layout seed + editor bridge hooks).
import {
  dispatchAction,
  registerAction,
  type AppExtension,
} from '@forgeax/app-shell/application';
import { DEFAULT_EDITOR_DOCK_LAYOUT } from '@forgeax/editor/default-dock-layout';
import { AppKitError } from '@forgeax/editor/app-kit';
import { EditorOverlayProvider } from '@forgeax/editor-ui/overlays';
// The viewport carrier is isolated; preview-only surfaces and business panels
// remain lightweight in-process components in the shell.
import { ViewportRuntimeFrame } from '@forgeax/editor-edit-runtime/runtime-frame';
import { ViewportComponent } from '@forgeax/editor-edit-runtime/viewport/viewport-component';
import { StandaloneEditRealm } from './StandaloneEditRealm';
import { createHostRuntimeGenerationAuthority } from '@forgeax/editor-edit-runtime/host-boot';
import { versionControlStatusBarExtension } from '@forgeax/editor-edit-runtime';
// Preview-slot wiring is SSOT'd behind the ./previews facade subpath so every
// host (standalone, Studio) registers the same three preview viewports.
import { registerEditorPreviewViewports } from '@forgeax/editor/previews';
// editor-panels is not a direct root dependency (zero-transitive src/ design,
// AGENTS.md) — reach EDITOR_PANEL_COMPONENTS through the root package's own
// `./panels` export (-> packages/panels/src/manifest.ts), the same
// self-import pattern as `@forgeax/editor/app-kit` above.
import {
  createEditorPanelsExtension,
  renderEditorPanel,
} from '@forgeax/editor/panels';
registerEditorPreviewViewports();
import { bindViewportRuntimeClient } from '@forgeax/editor-core';
import {
  createBroadcastViewportRuntimeClient,
  subscribeBroadcastViewportRuntimeReady,
  type MessagePortTransportClient,
  type ViewportRuntimeIdentity,
} from '@forgeax/editor/viewport-runtime';
import { installInterfaceBridge, setContextMenuRenderer, createEditorPanelContributionsExtension, createEditorPageExtension } from '@forgeax/editor/bridge';
import '@forgeax/editor-edit-runtime/theme.css';
import './standalone-chrome.css';
import './standalone-menu.css';
import {
  DeleteGuardDialogHost,
} from '@forgeax/editor-content-browser/delete-guard-entry';
import { DeleteGuardDialog } from './DeleteGuardDialog';

// The application host owns the single keyboard observer. Editor contributes
// its commands and raw viewport shortcuts through the extension lifecycle.
import { decodeSurfaceFromLocation } from '@forgeax/app-shell/window';
import {
  configureStudioDomainClients,
  createInterfaceApplicationOwner,
  installApplicationOverlayRedirect,
  startInterfaceApplication,
} from '@forgeax/interface/application';
import { StandaloneRuntimeRoot as OwnedStandaloneRuntimeRoot } from './StandaloneRuntimeRoot';
import { createEditorMenuExtension } from '@forgeax/editor/menu-contributions';
// keyboard-router deps builder is now shared (edit-runtime SSOT) so studio + this
// standalone host produce the SAME dep object — no divergence (the old inline copy
// here was silently missing from studio, killing its G/Esc keyboard path).
import {
  buildKeyboardRouterDeps,
  createEditorKeyboardExtension,
  type KeyboardRouterDepsShape,
} from '@forgeax/editor-edit-runtime/keyboard-router-deps';
import {
  errorMessage,
  forwardFeedbackHealth,
  normalizeSaveFailureCode,
} from '@forgeax/editor-edit-runtime';
import { projectViewportRuntimeOps } from '@forgeax/editor-edit-runtime/gateway-action-projection';
import { setPathResolver, trySaveActivePage } from '@forgeax/editor-core';
import { isDockPanelVisible } from '@forgeax/app-shell/dock';
import { installSettingsPanelRedirect, SETTINGS_PANEL_ID } from './settings-redirect';
import { createStandaloneGameClient } from './game-service-client';

// index.html declares the initial dark theme before this module loads.
// Application startup below owns locale initialization before extension setup.
const localeParam = new URLSearchParams(window.location.search).get('lang');
const requestedLocale = localeParam === 'en' || localeParam === 'zh' ? localeParam : undefined;

// Contextual F2/Delete/Mod+A belong to focused widget scopes. The remaining
// Editor shortcuts share their existing Gateway callbacks with menu commands.
// TEMPORARY: FORGEAX_STANDALONE_FORCE_IFRAME forces iframe carrier for smoke
// tests where GPU device-lost on page reload is not yet gracefully handled.
// Remove once single-realm mode handles disposal on navigation; all hosts
// should then default to in-process rendering unconditionally.
declare const __FORGEAX_STANDALONE_FORCE_IFRAME__: boolean;
const isIframeMode = new URLSearchParams(window.location.search).has('iframe')
  || __FORGEAX_STANDALONE_FORCE_IFRAME__;

function makeKeyboardRouterDeps(): KeyboardRouterDepsShape {
  const deps = buildKeyboardRouterDeps();
  if (!isIframeMode) {
    // In-process mode: gateway is live in this page — use it directly.
    return deps;
  }
  return {
    ...deps,
    // iframe mode: the shell's editor-core singleton has no live doc; route
    // save through the action registry which is projected from the iframe Runtime.
    // Active resource pages save through their page controller first.
    save: (): Promise<boolean> | undefined => {
      if (trySaveActivePage()) return;
      const request = dispatchAction(
        'saveDocToDisk',
        { requestId: `save-human-${crypto.randomUUID()}` },
        { source: 'human' },
      );
      return Promise.resolve(request).then((result: unknown) => {
        if (
          result !== null
          && typeof result === 'object'
          && 'status' in result
          && (result as { status?: unknown }).status === 'rejected'
        ) {
          forwardFeedbackHealth({
            source: 'edit',
            code: normalizeSaveFailureCode(result),
            message: errorMessage(result, 'The scene could not be saved.'),
          });
          return false;
        }
        return true;
      }).catch((error: unknown) => {
        console.error('[editor] iframe save dispatch failed:', error);
        forwardFeedbackHealth({
          source: 'edit',
          code: normalizeSaveFailureCode(error),
          message: errorMessage(error, 'The scene could not be saved.'),
        });
        return false;
      });
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
configureStudioDomainClients(createStandaloneGameClient(() => {
  window.setTimeout(() => window.location.reload(), 0);
}) satisfies Parameters<typeof configureStudioDomainClients>[0]);

// ── shell panel injection + isolated Runtime carrier (PanelRenderers v9) ──────
// v9 (2026-07-08) reclassified PanelRenderers into structural category slots:
//   surfaces.SceneEditor — the one Viewport Runtime carrier. SurfaceKeepAliveLayer
//     mounts the iframe once above the dockview 'viewport' anchor.
//   panels — Record<bareId, PanelDescriptor>; DockPanelHost looks each ep:*
//     panel body up here. (replaces the pre-v9 `renderEditorPanel(id)`)
//   editorPanelIds — the ep:* id list DockShell registers (SSOT: editor-core
//     manifest). Its absence renders every editor panel as "Panel not mounted".
// Mirrors studio's editorRenderers.tsx (the v9 reference assembly), minus the
// Studio-only chat/agents/overlays/detached/extension-transport slots.
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

function StandaloneSceneEditor(): ReactNode {
  const params = new URLSearchParams(window.location.search);
  const detachedRuntime = params.has('runtimeId');
  const forceIframe = params.has('iframe');

  // Detached runtime (popup / Tauri window): in-process ViewportComponent only.
  if (detachedRuntime) {
    return (
      <ViewportComponent
        gameSlug={__FORGEAX_GAME_SLUG__}
        gameRoot={__FORGEAX_GAME_SLUG__ ?? undefined}
        runtimeBinding={__FORGEAX_RUNTIME_BINDING__ ?? undefined}
      />
    );
  }

  // ?iframe fallback: legacy dual-realm path (for debugging / gradual rollback).
  if (forceIframe) {
    return <StandaloneIframeEditor />;
  }

  // Default: single-realm in-process engine (same architecture as Studio).
  return (
    <StandaloneEditRealm
      gameSlug={__FORGEAX_GAME_SLUG__}
      gameRoot={__FORGEAX_GAME_SLUG__ ?? undefined}
      runtimeBinding={__FORGEAX_RUNTIME_BINDING__ ?? undefined}
    />
  );
}

/** Legacy iframe-based viewport carrier, kept as ?iframe fallback. */
function StandaloneIframeEditor(): ReactNode {
  const authorityRef = useRef(createHostRuntimeGenerationAuthority(STANDALONE_VIEWPORT_RUNTIME));
  const [runtime, setRuntime] = useState(() => authorityRef.current.snapshot());
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
  useEffect(() => {
    const onGenerationReady = (event: Event): void => {
      const detail = (event as CustomEvent<{ runtimeGeneration?: unknown }>).detail;
      if (detail?.runtimeGeneration !== runtime.runtimeGeneration + 1) return;
      setRuntime(authorityRef.current.advance());
    };
    window.addEventListener('forgeax-generation-ready', onGenerationReady);
    return () => window.removeEventListener('forgeax-generation-ready', onGenerationReady);
  }, [runtime.runtimeGeneration]);
  return (
    <ViewportRuntimeFrame
      src="/editor/"
      runtime={runtime}
      reuseCarrierOnGenerationChange
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

/** Fields no Interface factory covers: the built-in Page layout seed and the
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
      builtinPageLayouts: { scene: DEFAULT_EDITOR_DOCK_LAYOUT },
      editor: {
        setContextMenuRenderer,
        installBridge: installInterfaceBridge,
      },
    });
    // The redirect needs the dock's live panel-visibility mirror so Ctrl+, /
    // the TopBar gear TOGGLES the ep:settings panel (open ↔ close) instead of
    // only ever re-opening it (the overlay store alone can't track a dock panel).
    const disposeRedirect = installSettingsPanelRedirect(
      installApplicationOverlayRedirect,
      ctx.bus,
      () => isDockPanelVisible(SETTINGS_PANEL_ID),
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
 *  (formerly the hideChatAndForge prop). Module-scope const so the product
 *  runtime start function remains referentially stable. */
const STANDALONE_OVERRIDES = {
  extensions: [
    createEditorKeyboardExtension(makeKeyboardRouterDeps()),
    createEditorMenuExtension(),
    createEditorPanelsExtension({ SceneEditor: StandaloneSceneEditor }),
    createEditorPanelContributionsExtension(),
    createEditorPageExtension(renderEditorPanel),
    standaloneEditorIntegrationExtension,
    versionControlStatusBarExtension,
  ] as readonly AppExtension[],
} as const;

function startStandaloneApplication() {
  return startInterfaceApplication(STANDALONE_OVERRIDES, { locale: requestedLocale });
}

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

  // Own the product runtime root and render Interface's public ApplicationShell.
  // The shell renders DockShell + SurfaceKeepAliveLayer + ContextMenu
  // (plan-strategy D-1: diff-set empty). The extension set injects standalone's
  // isolated Viewport Runtime + in-process editor panel slots; chat/Forge never
  // mount because nothing contributes them (AC-09, structural).
  //
  // EditorOverlayProvider (Prompt/Confirm/Toast) wraps the runtime root in the
  // SAME React root so that module-level singleton dispatchers (e.g. prompt.ts
  // `dispatcher`) share the exact same module instance as panels like
  // ContentBrowser that consume them. Previously a separate createRoot caused
  // Vite to resolve barrel vs subpath imports to distinct module instances,
  // breaking prompts.
  try {
    createRoot(rootEl).render(
      <StrictMode>
        <EditorOverlayProvider>
          <StandaloneRuntimeRoot>
            {(runtime) => (
              <ApplicationShell runtime={runtime} onboarding={{ enabled: false }} />
            )}
          </StandaloneRuntimeRoot>
        </EditorOverlayProvider>
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

function bootDetachedSurface(): void {
  const surface = decodeSurfaceFromLocation();
  if (surface === null) return;
  const appRoot = document.getElementById('app') ?? document.body;
  createRoot(appRoot).render(
    <StrictMode>
      <StandaloneRuntimeRoot>
        {(runtime) => (
          <ApplicationDetachedShell
            host={runtime.host}
            surface={surface}
            SurfaceProvider={EditorOverlayProvider}
          />
        )}
      </StandaloneRuntimeRoot>
    </StrictMode>,
  );
}

function StandaloneRuntimeRoot({ children }: {
  children: (runtime: Awaited<ReturnType<typeof startStandaloneApplication>>) => ReactNode;
}): ReactNode {
  const { t } = useTranslation();

  return (
    <OwnedStandaloneRuntimeRoot
      createOwner={createInterfaceApplicationOwner}
      start={startStandaloneApplication}
      messages={{
        title: t('standaloneRecovery.title'),
        hint: t('standaloneRecovery.hint'),
        retry: t('standaloneRecovery.retry'),
        remount: t('standaloneRecovery.remount'),
        reloadApplication: t('standaloneRecovery.reloadApplication'),
      }}
      shutdownMessages={{
        title: t('standaloneRecovery.shutdownTitle'),
        hint: t('standaloneRecovery.shutdownHint'),
        retry: t('standaloneRecovery.retryShutdown'),
      }}
      reloadApplication={() => window.location.reload()}
      revealError={() => {
        (window as unknown as { __forgeaxBoot?: { done(): void } }).__forgeaxBoot?.done();
      }}
    >
      {children}
    </OwnedStandaloneRuntimeRoot>
  );
}

if (decodeSurfaceFromLocation() !== null) bootDetachedSurface();
else boot();
