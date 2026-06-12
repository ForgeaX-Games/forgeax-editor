// @forgeax/editor-play-runtime — Play mode thick host
//
// This is the full-featured Play-mode runtime host (~488 lines).
// Loads games via @forgeax/engine-app `loadGame` with features:
//   - FPS mouse capture (via Tauri fx-pointer-capture message)
//   - Physics gate (per-game opt-in via forge.json)
//   - Per-game pack-index
//   - Loading overlay + first-frame fade-out
//   - Diagnostic overlay (WebGPU unavailable / init failed)
//   - VAG_CONSOLE bridge (console hijack + structured errors + HMR build error forwarding)
//   - FPS stats reporting (VAG_FPS_STATS postMessage)
//   - Pause/Play/Reload (VAG_PREVIEW_* protocol)
//
// Re-exported for AppKit / standalone consumers.

export type { GameContext } from './types';