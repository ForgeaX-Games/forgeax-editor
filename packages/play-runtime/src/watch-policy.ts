/** Runtime-owned files that can appear below a workspace link but must never
 * participate in source or game-asset hot reload. */
export const PLAY_RUNTIME_STATIC_WATCH_IGNORES = Object.freeze([
  '**/.forgeax/agenteam-state/**',
  '**/.forgeax/cache/**',
  '**/.forgeax/chrome-webgpu-profile/**',
  '**/.forgeax/packs/**',
  '**/node_modules/**',
]);
