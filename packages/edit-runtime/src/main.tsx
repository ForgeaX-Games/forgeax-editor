// forgeax editor-runtime — thin entry (plan-strategy REPLAN D8; S4 R8).
//
// This file used to be a 1652-line module whose bootEditor() closure interleaved
// the engine viewport surface AND the whole application session. M2 (D8) split
// that closure into two edit-runtime modules the :15290 host can import:
//   - engine/ViewportComponent.tsx — canvas + createApp + renderer + camera +
//     viewport interaction + VAG bridges (the ENGINE SURFACE). It also runs the
//     shared session setup (configureHostSession) + host-boot session tail.
//   - host-boot.ts               — configureHostSession (scene id + path resolver
//     + scene manifest) + seed / scene-load / ▶ Play / preload / mesh-stats /
//     preview-skin / sync / disk-watch (the APPLICATION SESSION).
//
// main.tsx is now just the edit-runtime STANDALONE DEV ENTRY (`bun -F
// edit-runtime dev`, the e2e second webServer): either the pop-out single-panel
// path or mount ViewportComponent. It shares the exact same ViewportComponent +
// host-boot the :15290 host uses, so the two hosts cannot drift (architecture-
// principles S1 SSOT; S4 R8 keeps edit-runtime green).

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ViewportComponent } from './viewport/ViewportComponent';
import { installShortcutForwarder } from '@forgeax/editor-core/shortcut-forwarder';
import './theme.css';

// todo 004: When this Edit viewport is embedded by studio, forward global
// shortcuts (⌘K command palette / Ctrl+Shift+* / Esc) to the studio shell.
// The standalone top-level window keeps this as a no-op.
export interface EditRuntimeHostInjection {
  readonly root?: HTMLElement;
  readonly gameSlug: string | null;
  readonly gameRoot?: string;
}

export function mountEditRuntime(host: EditRuntimeHostInjection): void {
  const appRoot = host.root ?? document.getElementById('app') ?? document.body;
  createRoot(appRoot).render(
    <StrictMode>
      <ViewportComponent gameSlug={host.gameSlug} gameRoot={host.gameRoot ?? host.gameSlug ?? undefined} />
    </StrictMode>,
  );
}

installShortcutForwarder();

// M3: single-realm — sync engine deleted (plan-strategy S7 M3).
// Popout entry branch is dead code, removed in place.
// Default path: mount the in-process viewport surface.
{
  // The active game comes from the --game dir (basename === slug), injected at
  // build time as __FORGEAX_GAME_SLUG__; game files are addressed by <slug>/<rel>
  // so gameRoot === slug. Passed as props (NOT `?scene=`/`?gameRoot=` URL params).
  mountEditRuntime({ gameSlug: __FORGEAX_GAME_SLUG__ });
}
