// Ambient declarations for build-time globals injected by edit-runtime's vite
// `define` (see vite.config.ts). These are not real runtime imports — vite
// string-replaces them — so they live here as ambient `declare const`, out of
// module statement position (a `declare` mid-module trips TS1184).

// Injected from FORGEAX_GAME_DIR (cli.mjs `--game`). The ABSOLUTE game dir that
// DIRECTLY contains forge.json — standalone serves one game at an arbitrary dir,
// no host server. null when embedded in studio (uses the injected `?gameRoot=`
// under the project root reported by /api/health).
declare const __FORGEAX_GAME_DIR_ABS__: string | null;
