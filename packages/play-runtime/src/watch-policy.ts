import { posix } from 'node:path';

/**
 * Vite `server.hmr.path` is joined onto Play `base` (`/preview/`).
 *
 * It must stay relative. The previous default used `base` itself, so the HMR
 * websocket was `ws://…/preview/` — the same path as the HTML document. Studio's
 * ws-proxy then closed the socket before handshake; Vite's client reacts with
 * `location.reload()`. In the same-origin Play iframe that reload can take down
 * the Studio shell, mint a new carrier identity, and leave ▶ on a live picture.
 */
export const PLAY_VITE_HMR_PATH = '__vite_hmr';

/** Public websocket path after Vite joins `base` + `PLAY_VITE_HMR_PATH`. */
export function playViteHmrSocketPath(base = '/preview/'): string {
  return posix.join(base, PLAY_VITE_HMR_PATH);
}

/** Runtime-owned files that can appear below a workspace link but must never
 * participate in source or game-asset hot reload. */
export const PLAY_RUNTIME_STATIC_WATCH_IGNORES = Object.freeze([
  '**/.forgeax/agenteam-state/**',
  '**/.forgeax/cache/**',
  '**/.forgeax/chrome-webgpu-profile/**',
  '**/.forgeax/packs/**',
  '**/node_modules/**',
  // Junction remounts of the active game appear as new files under the Vite
  // root (`host-games/<slug>/tsconfig.json`). Vite 8 treats any tsconfig add
  // as a config change, clears the module graph, and full-reloads Play.
  '**/host-games/**/tsconfig.json',
  '**/host-games/**/jsconfig.json',
  '**/host-games/**/package.json',
]);
