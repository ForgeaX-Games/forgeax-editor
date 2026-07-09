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

// todo 004:本 Edit 视口作为 studio 的 iframe 嵌入时,把全局快捷键(⌘K 命令面板 /
// Ctrl+Shift+* / Esc)转发给 studio 顶层。独立运行(顶层窗口)时是 no-op。
installShortcutForwarder();

// M3: single-realm — sync engine deleted (plan-strategy S7 M3).
// Popout entry branch is dead code, removed in place.
// Default path: mount the in-process viewport surface.
{
  const appRoot = document.getElementById('app') ?? document.body;
  createRoot(appRoot).render(
    <StrictMode>
      <ViewportComponent />
    </StrictMode>,
  );
}
