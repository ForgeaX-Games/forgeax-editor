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
// Why a relative import instead of `from '@forgeax/editor-core'`:
//   editor-shared's barrel re-exports `./store` / `./ops` /
//   `./context-menu-service` / `./dock-bridge` which transitively load
//   `@forgeax/engine-runtime` (via editor-core/assets.ts). bun's module
//   resolver eagerly walks `export … from` re-exports at module load,
//   so the barrel pulls the entire engine chain into scope and AC-04
//   (file: install) cannot resolve the engine workspaces under an
//   external consumer's node_modules tree. Going relative to
//   `../packages/core/src/manifest` reaches the SSOT file
//   directly (its only export is the EDITOR_PANELS const tuple — no
//   side-effect imports). C-08's "5-subpkg-freeze" is preserved: this
//   relative path is read-only from the entry above the 5 subpkgs and
//   touches no file inside them. (Plan blind-spot: w2b/§4 R2 asked
//   for `from '@forgeax/editor-core'` but the barrel makes that
//   non-zero-transitive; scope-amendment rationale recorded in
//   implement-progress.jsonl scope-amended event.)
//
// Anchors:
//   requirements §5 AC-03 (manifest.id === 'editor', root entry resolves)
//   requirements §5 AC-04 (manifest.panels = EDITOR_PANELS, 8 elements)
//   plan-strategy §2 D-5 (zero-transitive root entry form)
//   plan-strategy §4 R2 (no side-effect imports of runtime sub-packages)

import { defineApp } from './app-kit';
import { EDITOR_PANELS } from '../packages/core/src/manifest';

// `viewportOnly=1` query param: runtime contract.
//
// `?viewportOnly=1` tells the iframe-mounted editor runtime (served on
// :15280, packages/editor/packages/edit-runtime + play-runtime) to render
// only the 3D viewport surface and suppress any host-only chrome the
// runtime might otherwise paint inside the iframe. Hosts (forgeax-studio
// at :18920, the standalone shell at :15290) are responsible for the
// surrounding panels / dock / chat surfaces; the iframe is purely the
// 3D canvas. The flag is the documented contract between the iframe
// runtime and host: it is part of the public manifest below
// (`entryUrl`), is asserted by `packages/editor/src/index.test.ts`,
// and is the value mounted by `packages/editor/standalone/main.tsx`.
// Removing the flag is a host-vs-iframe boundary change and requires
// an ADR. (verify R1 Pure-trial F-3 carry-over: discoverability
// docstring, not a behavioural change.)
const editorApp = defineApp({
  id: 'editor',
  entryUrl: 'http://127.0.0.1:15280/?viewportOnly=1',
  panels: EDITOR_PANELS.map((id) => ({ id })),
  surfaces: [],
  routes: [],
});

// Named `app` export — preferred entry for AppKit consumers
// (e.g. `mountStandalone(editorApp)` in standalone-editor-demo). Both
// the named `manifest` re-export and the default export remain so that
// existing AC-03 / AC-04 / AC-16 assertions stay green.
export const app = editorApp;
export const manifest = editorApp.manifest;

// Convenience re-exports of the AppKit mount entry points so downstream
// SDK consumers who only `import` from `@forgeax/editor` can reach
// `mountStandalone` / `mountComposition` without a second-hop import
// from `@forgeax/interface/app-kit`. These are pure pass-throughs of
// the same symbols already in scope above (no side-effect imports
// added: zero-transitive root entry per plan-strategy section 2 D-5).
// (verify R1 Pure-trial F-1 carry-over: single-hop discoverability.)
export { mountStandalone, mountComposition, AppKitError } from './app-kit';
export type {
  MountStandaloneOptions,
  MountOptions,
  AppManifest,
  AppManifestPanel,
  DefinedApp,
} from './app-kit';

export default editorApp;
