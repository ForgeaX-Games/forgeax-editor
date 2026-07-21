// Standalone editor chrome entry — :15290 host page (single realm, M2).
//
// SINGLE-REALM ASSEMBLY (plan-strategy REPLAN D4/D8; requirements AC-04/AC-05):
//   Before M2 this host rendered the viewport AND every ep:* panel as iframes to
//   edit-runtime (:15280) — each iframe a SEPARATE module realm with its own
//   EditorBus + engine. M2 collapses the editor to ONE realm: the engine boots
//   ONCE in THIS window (via ViewportComponent's single-boot latch) and both the
//   viewport and the ep:* panels are in-process React components assembled through
//   DockShell's injection slots:
//     - renderEdit         -> ViewportComponent (the in-process engine surface,
//                             imported from @forgeax/editor-edit-runtime).
//     - renderEditorPanel  -> EDITOR_PANEL_COMPONENTS[id] (in-process panel
//                             component; placeholder for ids with no component).
//   There is NO /editor iframe anywhere (the root vite `/editor` proxy is deleted
//   too — the host bundler serves the engine in-process via engine-vite-preset).
//
// AC-spec-matrix:
//   AC-04a — no editor panel/viewport iframe (page has no ?panel= / ?viewportOnly=1)
//   AC-04b — the engine <canvas> lives in THIS document (in-process viewport)
//   AC-04c — DockShell still registers every ep:* panel (now component slots)
//   AC-05  — panels + chat share one flat dock, freely interleaved
//   AC-09  — no chat/Forge in the standalone host (structural: no extension
//            contributes panels.chat — formerly the hideChatAndForge prop)
//
// Anchors: plan-strategy S2 D4/D5/D6/D8, S3.1 host entry; requirements AC-04/05/09;
//          research Finding 2/3/7.

import { StrictMode, type ReactNode } from 'react';
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
import { useShellStore } from '@forgeax/interface/store';
import { STORAGE_KEYS } from '@forgeax/interface/lib/storageKeys';
import { AppKitError } from '@forgeax/editor/app-kit';
import { EditorOverlayProvider } from '@forgeax/editor-ui/overlays';
// Single-realm surfaces — imported IN-PROCESS from edit-runtime's D8 subpath
// exports (no iframe). ViewportComponent boots the engine once in this window;
// EDITOR_PANEL_COMPONENTS maps ep:<id> -> the panel's React component.
import { ViewportComponent } from '@forgeax/editor-edit-runtime/viewport/viewport-component';
// editor-panels is not a direct root dependency (zero-transitive src/ design,
// AGENTS.md) — reach EDITOR_PANEL_COMPONENTS through the root package's own
// `./panels` export (-> packages/panels/src/manifest.ts), the same
// self-import pattern as `@forgeax/editor/app-kit` above.
import { EDITOR_PANEL_COMPONENTS } from '@forgeax/editor/panels';
// EDITOR_PANELS id-list SSOT (editor-core manifest) — feeds v9 editorPanelIds
// + the panels registry keys, same source studio's editorRenderers uses.
import { EDITOR_PANELS } from '@forgeax/editor-core/manifest';
import { installInterfaceBridge, setContextMenuRenderer } from '@forgeax/editor-core';
import '@forgeax/interface/styles/global.css';
import './standalone-chrome.css';
import './standalone-menu.css';
// T4-3 / AC-C2: UI-layer DeleteGuardDialog for risky asset deletes — core stays
// headless, the router requests a human confirm through this bus.
import { requestDeleteGuard } from './delete-guard-bus';
import { DeleteGuardDialog } from './DeleteGuardDialog';

// keyboard-router convergence M4: the interface submodule's global-shortcuts
// router is editor-agnostic (lint:agnostic forbids importing @forgeax/editor),
// so we inject the editor-side callbacks it needs here — once, before React
// mounts (useGlobalShortcuts reads them at effect time). This keeps a SINGLE
// global keydown listener (G-1 / AC-A1) while routing Delete/F2/Ctrl+D/Ctrl+A/G
// through the one gateway door.
import { registerKeyboardRouterDeps, type KeyboardRouterDeps } from '@forgeax/interface/lib/global-shortcuts';
// keyboard-router deps builder is now shared (edit-runtime SSOT) so studio + this
// standalone host produce the SAME dep object — no divergence (the old inline copy
// here was silently missing from studio, killing its G/Esc keyboard path).
import { buildKeyboardRouterDeps } from '@forgeax/editor-edit-runtime/keyboard-router-deps';

// lastSelectionDomain is a SINGLE-source Derive of "who was selected last"
// (AC-C1 / T5-1): entity and asset forward-selects each advance it; clear() does
// NOT (C2-1). The router reads it (via this dep) to decide which domain
// Delete/F2/Ctrl+D/Ctrl+A act on, and the panel header rings read it (via the
// useLastSelectionDomain hook) to show the current Delete jurisdiction. The
// Derive itself lives in editor-core (store/last-selection-domain) so router and
// UI share one source — no second divergent state (G-3).

// Standalone's router deps = the shared SSOT builder + this host's DeleteGuardDialog
// bus as the risky-multi-delete confirm gate (the one host-specific piece).
function makeKeyboardRouterDeps(): KeyboardRouterDeps {
  return buildKeyboardRouterDeps({
    confirmDeleteAssets: (assets) => requestDeleteGuard({ assets }),
  }) as KeyboardRouterDeps;
}

// Injected by vite `define` (vite.config.ts) from FORGEAX_GAME_DIR's basename.
// null when the stack was started without `cli.mjs run --game <dir>` — in that
// case no game is served and the editor opens on an empty scene.
declare const __FORGEAX_GAME_SLUG__: string | null;

// ── panel renderer injection (single realm, PanelRenderers v9 shape) ──────────
// v9 (2026-07-08) reclassified PanelRenderers into structural category slots:
//   surfaces.SceneEditor — the in-process engine viewport (NOT an iframe).
//     SurfaceKeepAliveLayer mounts it once above the dockview 'viewport' anchor.
//     (replaces the pre-v9 `renderEdit(opts)` render function)
//   panels — Record<bareId, PanelDescriptor>; DockPanelHost looks each ep:*
//     panel body up here. (replaces the pre-v9 `renderEditorPanel(id)`)
//   editorPanelIds — the ep:* id list DockShell registers (SSOT: editor-core
//     manifest). Its absence renders every editor panel as "Panel not mounted".
// Mirrors studio's editorRenderers.tsx (the v9 reference assembly), minus the
// studio-only chat/agents/overlays/detached/hostSDK slots.
function EditorPanelBody({ id }: { id: string }): ReactNode {
  const Comp = EDITOR_PANEL_COMPONENTS[id];
  if (Comp) return <Comp />;
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
  launcher: 'Launcher', 'asset-inspector': 'Asset Inspector',
};

const standalonePanels: Record<string, PanelDescriptor> = Object.fromEntries(
  EDITOR_PANELS.map((id, i) => [id, {
    title: EDITOR_PANEL_TITLES[id] ?? id,
    order: 100 + i,
    ...(id === 'assets' ? { header: { visible: true, showTitle: false } } : {}),
    render: () => <EditorPanelBody id={id} />,
  }]),
);

// Module-scope named component (stable identity across renders — no re-mounts).
// viewportOnly is accepted for slot-signature parity; the in-process component
// always renders the full engine surface. The active game is the CLI `--game`
// dir (its basename === slug), injected at build time as __FORGEAX_GAME_SLUG__.
// game-backend addresses files by <slug>/<rel>, so gameRoot === slug here. Passed
// as props (NOT `?scene=`/`?gameRoot=` URL params — the single realm removed the
// iframe those addressed, so a stale URL can no longer override the CLI intent).
function StandaloneSceneEditor(_props: { viewportOnly?: boolean }): ReactNode {
  return <ViewportComponent gameSlug={__FORGEAX_GAME_SLUG__} gameRoot={__FORGEAX_GAME_SLUG__ ?? undefined} />;
}

/** Fields no interface factory covers: the workbench layout seed and the
 *  editor bridge hooks — one custom extension keeps them on the same
 *  contributePanels channel (mirrors studio's studio.editor-integration). */
const standaloneEditorIntegrationExtension: AppExtension = {
  id: 'standalone.editor-integration', version: '1.0.0',
  requires: ['panels'],
  setup(ctx) {
    return ctx.contributePanels({
      builtinWorkbenchLayouts: { scene: DEFAULT_EDITOR_DOCK_LAYOUT },
      editor: { setContextMenuRenderer, installBridge: installInterfaceBridge },
    });
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
    standaloneEditorIntegrationExtension,
  ] as readonly AppExtension[],
} as const;

function boot(): void {
  const rootEl = document.getElementById('root');
  if (!rootEl) {
    // Charter P3 — explicit failure with a code AI users can branch on.
    throw new AppKitError({
      code: 'INVALID_ROOT_EL',
      hint: '#root element not present in standalone/index.html',
      expected: '<div id="root"></div>',
    });
  }

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
  // standalone's in-process ViewportComponent + editor panel slots; chat/Forge
  // never mount because nothing contributes them (AC-09, structural).
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

  // T4-3 / AC-C2: mount the UI-layer DeleteGuardDialog on its own React root so
  // the keyboard router (which runs outside React, in the DI above) can request a
  // human confirm. Dedicated root keeps the dialog above the dock chrome.
  try {
    const guardEl = document.createElement('div');
    guardEl.id = 'delete-guard-root';
    document.body.appendChild(guardEl);
    createRoot(guardEl).render(
      <StrictMode>
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
        <EditorOverlayProvider>{null}</EditorOverlayProvider>
      </StrictMode>,
    );
  } catch (err) {
    console.error('[standalone] EditorOverlayProvider mount failed:', err);
  }
}

boot();
