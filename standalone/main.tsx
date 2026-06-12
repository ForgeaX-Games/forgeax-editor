// Standalone editor chrome entry — boots the editor app via app-kit's
// mountStandalone with the bandage flag set so the SDK records the
// host's chrome-suppression intent. This file is the AC-07 + AC-08
// landing point; the editor surface itself lives in the iframe at
// app.manifest.entryUrl (`packages/editor/packages/edit-runtime/`,
// :15280 viewport).
//
// Plan §2 D-4 keeps the studio chrome suppression entirely on the React
// side: `<App hideChatAndForge>` is the rendered shell, but the standalone
// host does NOT render `<App>` directly — the iframe IS the chrome.
// `hideChatAndForge: true` is still passed through mountStandalone so:
//   1. AI-user grep `mountStandalone\(.*hideChatAndForge:\s*true` lands
//      on this file directly (plan §8 AI-friendly contract).
//   2. The SDK boundary records the intent uniformly with future hosts
//      that DO render `<App hideChatAndForge>` for richer chrome.
//
// Anchors:
//   requirements AC-07  (mountStandalone with DefinedApp + hideChatAndForge)
//   requirements AC-08  (vite root listens on :15290; editor iframe at
//                        :15280 + studio server :18900 reused, OOS-8)
//   requirements AC-09  (chat-panel + forge-entry testids absent here)
//   plan §2 D-1         (atomic single-PR consolidation)
//   plan §2 D-4         (prop drilling stays React-side; SDK passes flag)
//   plan §8             (this file IS the SDK consumption sample)

import { mountStandalone } from '@forgeax/interface/app-kit';
import editorApp from '@forgeax/editor';

mountStandalone(editorApp, { hideChatAndForge: true });

// Test hook (e2e parity with the legacy standalone-editor-demo). Bare
// module specifiers do not resolve through a runtime `import()` in a
// browser context, so the playwright spec reaches mountStandalone via
// this window-level handle.
//
// biome-ignore lint/suspicious/noExplicitAny: test hook injection
(window as any).__forgeaxStandaloneTest = { mountStandalone, editorApp };
