// @forgeax/editor — top-level package root entry.
//
// This is the single bare-specifier entry that external consumers (e.g. the
// standalone-editor-demo, future host-sdk surface composition) reach via
// `import editor from '@forgeax/editor'`. Per plan-strategy §2 D-5 the
// entry must be **zero-transitive**: it imports only `defineApp` from
// `@forgeax/interface/app-kit` and the EDITOR_PANELS literal from
// editor-shared. It deliberately does NOT import the edit-runtime /
// play-runtime / panels side-effect code, so the bare specifier resolves
// cleanly under bun's file: protocol without dragging in vite-only
// sub-trees (research §F1 file: import semantics, plan §4 R2).
//
// Why a relative import instead of `from '@forgeax/editor-shared'`:
//   editor-shared's barrel re-exports `./store` / `./ops` /
//   `./contextMenuService` / `./dock-bridge` which transitively load
//   `@forgeax/engine-runtime` (via editor-core/assets.ts). bun's module
//   resolver eagerly walks `export … from` re-exports at module load,
//   so the barrel pulls the entire engine chain into scope and AC-04
//   (file: install) cannot resolve the engine workspaces under an
//   external consumer's node_modules tree. Going relative to
//   `../packages/editor-shared/src/manifest` reaches the SSOT file
//   directly (its only export is the EDITOR_PANELS const tuple — no
//   side-effect imports). C-08's "5-subpkg-freeze" is preserved: this
//   relative path is read-only from the entry above the 5 subpkgs and
//   touches no file inside them. (Plan blind-spot: w2b/§4 R2 asked
//   for `from '@forgeax/editor-shared'` but the barrel makes that
//   non-zero-transitive; scope-amendment rationale recorded in
//   implement-progress.jsonl scope-amended event.)
//
// Anchors:
//   requirements §5 AC-03 (manifest.id === 'editor', root entry resolves)
//   requirements §5 AC-04 (manifest.panels = EDITOR_PANELS, 8 elements)
//   plan-strategy §2 D-5 (zero-transitive root entry form)
//   plan-strategy §4 R2 (no side-effect imports of runtime sub-packages)

import { defineApp } from '@forgeax/interface/app-kit';
import { EDITOR_PANELS } from '../packages/editor-shared/src/manifest';

const app = defineApp({
  id: 'editor',
  entryUrl: 'http://127.0.0.1:15280/?viewportOnly=1',
  panels: EDITOR_PANELS.map((id) => ({ id })),
  surfaces: [],
  routes: [],
});

export const manifest = app.manifest;

export default { manifest };
