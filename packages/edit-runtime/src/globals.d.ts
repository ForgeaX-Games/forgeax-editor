// Ambient declarations for build-time globals injected by edit-runtime's vite
// `define` (see vite.config.ts). These are not real runtime imports — vite
// string-replaces them — so they live here as ambient `declare const`, out of
// module statement position (a `declare` mid-module trips TS1184).

// Injected from FORGEAX_GAME_DIR (fx.ts `--game`). The ABSOLUTE game dir that
// DIRECTLY contains forge.json — standalone serves one game at an arbitrary dir,
// no host server. null when embedded in studio (studio passes the game to
// ViewportComponent via props under the project root reported by /api/health).
declare const __FORGEAX_GAME_DIR_ABS__: string | null;

// Injected from FORGEAX_GAME_DIR's basename (the game slug). The dev entry passes
// it to ViewportComponent as props so the engine boots the right game. null when
// no --game (empty scene) or embedded in studio (studio supplies its own slug).
declare const __FORGEAX_GAME_SLUG__: string | null;
