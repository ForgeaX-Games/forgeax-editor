// path-resolver.ts — host-injected game file-path resolver (decoupling, 2026-06-25).
//
// WHY THIS EXISTS:
//   editor-core / editor-shared are PURE LIBRARIES. They open ONE game by a bare
//   pointer (`<slug>`) and must know NOTHING about where that game lives on disk
//   or how the host lays games out. The studio on-disk games-directory layout is
//   the HOST's concern, not the editor's. Baking it into the library violated
//   architecture-principles §4 (Pipeline Isolation): a pure stage held an upper
//   layer's implicit layout convention.
//
//   This module is the explicit seam. editor-core code asks for game-INTERNAL
//   relative paths ('forge.json', 'scenes/main.pack.json', 'assets/foo.glb') and
//   the HOST-injected resolver maps them to wherever the game actually is. The
//   slug is captured in the host's closure — editor-core never passes it (the
//   same contract open-project.ts's reader(path) already got right; this just
//   promotes it to the main store path).
//
// CONTRACT (mirrors setSceneId/getSceneId singleton, store.ts):
//   setPathResolver(r)      — host installs its <slug>→disk mapper
//   resolveGamePath(rel)    — library asks for a game-relative path
//   hasPathResolver()       — guard for optional/diagnostic paths
//
// FAIL FAST (§5): resolveGamePath with no resolver installed THROWS
//   EditorPathResolverError('PATH_RESOLVER_NOT_SET') — it never silently falls
//   back to `.forgeax/…`, because that convention is exactly what we removed.
//   The host (edit-runtime adapter) installs a default resolver at boot, right
//   after setSceneId; standalone with no game (slug 'default') is guarded by the
//   existing `currentSceneId === 'default'` early-returns at the call sites, so
//   the resolver is never reached.

/**
 * Maps a game-INTERNAL relative path (e.g. 'forge.json', 'scenes/main.pack.json')
 * to a host-resolvable path. The game pointer (slug) is captured in the host's
 * closure — the library never supplies it. An empty `rel` yields the game root.
 */
export type PathResolver = (rel: string) => string;

export class EditorPathResolverError extends Error {
  constructor(public readonly code: 'PATH_RESOLVER_NOT_SET') {
    super(
      `[editor-core] path resolver not installed (${code}). The host must call ` +
      `setPathResolver(...) before any game file is read/written. editor-core is ` +
      `layout-agnostic by design — it does not know where games live on disk.`,
    );
    this.name = 'EditorPathResolverError';
  }
}

let resolver: PathResolver | null = null;

/** Host installs the <slug>→disk path mapper. Pass null to uninstall (tests). */
export function setPathResolver(r: PathResolver | null): void {
  resolver = r;
}

/** True once a resolver is installed — guard for optional/diagnostic paths. */
export function hasPathResolver(): boolean {
  return resolver !== null;
}

/**
 * Resolve a game-relative path to a host path. Throws EditorPathResolverError
 * (Fail Fast §5) if no resolver is installed — never falls back to a baked-in
 * disk convention.
 */
export function resolveGamePath(rel: string): string {
  if (!resolver) throw new EditorPathResolverError('PATH_RESOLVER_NOT_SET');
  return resolver(rel);
}
