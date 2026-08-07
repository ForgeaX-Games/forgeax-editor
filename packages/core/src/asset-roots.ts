// asset-roots — editor-layer resolution of a game's declared asset roots,
// including EXTERNAL/shared roots addressed by the `@shared/<sub>` alias.
//
// WHY THIS EXISTS (architecture-principles §1 SSOT / §2.5 Depend-on-Abstractions)
//   The engine's `loadAssetConfig` (@forgeax/engine-pack/config) is the SSOT for
//   `package.json#forgeax.assets`, but it resolves every declared root with a
//   blind `join(cwd, r)` — so it can only address dirs UNDER the game dir. Shared
//   assets (the `forgeax-editor-assets/` submodule: template sky.hdr, character
//   GLBs, …) used to reach games through a SECOND, hardcoded mechanism
//   (`sharedAssetRoots()` / `sharedTemplateRoots()` in the two vite configs).
//   Two mechanisms for one fact ("which dirs are this game's asset roots") is the
//   §1 violation this helper removes: a game now declares ALL its roots — local
//   AND shared — in the single `forgeax.assets.roots` list, and this helper is
//   the ONE place that resolves the `@shared/` alias before the paths reach the
//   engine (which would otherwise mangle `@shared/x` into `<gameDir>/@shared/x`).
//
// WHY AN EDITOR-LAYER ALIAS (not a relative path, not an engine change)
//   A bare relative path like `../../forgeax-editor-assets/x` is DEPTH-COUPLED:
//   it only lands on the shared submodule for a game exactly two levels deep
//   (`games/sample`); a template four levels deep (`packages/engine/templates/
//   game-default`) resolves it wrong. `@shared/<sub>` is a fixed sentinel — the
//   SAME literal works at any depth — resolved here against a caller-supplied
//   `sharedBase`. Teaching the engine `loadAssetConfig` about `@shared/` was
//   rejected: it would push an editor-repo layout convention into the engine
//   submodule (whose own apps/preview reads a DIFFERENT assets submodule).
//
// WHY IT LIVES IN @forgeax/editor-core (exposed at ./asset-roots, NOT the barrel)
//   Both consumers — packages/play-runtime/vite.config.ts and
//   packages/edit-runtime/src/viewport/runtime-vite-preset.ts — depend on
//   @forgeax/editor-core, so a single helper here can't drift between the two
//   configs. It is a DEDICATED sub-path export (like @forgeax/engine-pack/config),
//   NOT re-exported from src/index.ts, because it imports node:fs/node:path and
//   the core barrel is browser-bundled — keeping it off the barrel keeps browser
//   builds free of node builtins.

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The alias prefix that addresses the shared `forgeax-editor-assets/` submodule. */
export const SHARED_ROOT_PREFIX = '@shared/';

/**
 * One resolved asset root.
 * - `abs`    — absolute on-disk path (existence NOT guaranteed here; see filter).
 * - `shared` — true when declared via `@shared/<sub>` (an external/submodule root).
 * - `sub`    — for shared roots, the `<sub>` segment after `@shared/` (e.g.
 *              `characters`, `template-game-default`). Used by play-runtime to
 *              name the per-root symlink in its farm. Absent for local roots.
 */
export interface ResolvedRoot {
  readonly abs: string;
  readonly shared: boolean;
  readonly sub?: string;
}

/**
 * Read a game's RAW declared asset roots from its package.json#forgeax.assets.roots,
 * WITHOUT resolving them to paths. Mirrors the parse in @forgeax/engine-pack/config
 * (SSOT for the schema) but returns the literal strings so the caller can resolve
 * the `@shared/` alias itself. Falls back to `['assets']` — the engine default —
 * on any read/parse error or missing field.
 */
export function readDeclaredRoots(gameDirAbs: string): string[] {
  let pkg: { forgeax?: { assets?: { roots?: unknown } } };
  try {
    pkg = JSON.parse(readFileSync(join(gameDirAbs, 'package.json'), 'utf-8'));
  } catch {
    return ['assets'];
  }
  const rawRoots = pkg.forgeax?.assets?.roots;
  return Array.isArray(rawRoots) && rawRoots.length > 0
    ? (rawRoots as unknown[]).filter((r): r is string => typeof r === 'string')
    : ['assets'];
}

export interface ResolveOptions {
  /** Absolute path the `@shared/` alias resolves against (the forgeax-editor-assets submodule dir). */
  readonly sharedBase: string;
  /**
   * Extra shared sub-scopes to inject even if the game didn't declare them.
   * Used by edit-runtime's default-template path (4b-ii): the demo-seed template
   * scene references the shared sky.hdr equirect GUID but its own assets/ has no
   * sky.hdr, so the editor injects `template-game-default` implicitly rather than
   * editing the engine submodule's template package.json. Each entry is a `<sub>`
   * (no `@shared/` prefix), resolved the same way as a declared `@shared/<sub>`.
   */
  readonly implicitSharedSubs?: readonly string[];
}

/**
 * Resolve a game's declared roots (plus any implicit shared subs) into
 * `ResolvedRoot[]`, expanding the `@shared/<sub>` alias against `sharedBase`.
 * Non-existent paths are filtered out (mirrors the callers' existing
 * `.filter(existsSync)`). De-duplicates by absolute path (a root can't appear
 * twice even if declared + injected).
 */
export function resolveGameAssetRoots(
  gameDirAbs: string,
  opts: ResolveOptions,
): ResolvedRoot[] {
  const declared = readDeclaredRoots(gameDirAbs);
  const implicit = (opts.implicitSharedSubs ?? []).map((sub) => `${SHARED_ROOT_PREFIX}${sub}`);

  const out: ResolvedRoot[] = [];
  const seen = new Set<string>();
  const push = (r: ResolvedRoot): void => {
    if (seen.has(r.abs)) return;
    if (!existsSync(r.abs)) return;
    seen.add(r.abs);
    out.push(r);
  };

  for (const r of [...declared, ...implicit]) {
    if (r.startsWith(SHARED_ROOT_PREFIX)) {
      const sub = r.slice(SHARED_ROOT_PREFIX.length);
      push({ abs: resolve(opts.sharedBase, sub), shared: true, sub });
    } else {
      push({ abs: resolve(gameDirAbs, r), shared: false });
    }
  }
  return out;
}
