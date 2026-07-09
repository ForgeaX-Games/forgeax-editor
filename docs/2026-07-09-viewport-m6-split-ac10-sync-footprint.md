# M6 viewport three-file split — AC-10 controlled-intersection sync footprint

> [!IMPORTANT]
> **Audience: whoever merges SECOND** between this loop
> (`feat-20260709-editor-large-file-di-decompose-wave2-c-domain-scen`, the "C" /
> large-file DI-decompose loop) and its sister loop
> (`feat-20260709-editor-world-partition-...`, the world-partition super-composite
> loop). Per requirements **AC-10** + plan-strategy **§2 D-5** the two loops touch
> the SAME three viewport files, and the second merger must **sync** — not blindly
> overwrite. This file is the exact footprint C landed so that sync is mechanical.

## What C changed (this loop)

C did a **pure, zero-behavior structural split** (OOS-1 / AC-05). It moved cohesive
clusters OUT of the two big viewport files into two new sibling modules. It
**rewrote nothing** — the three world-partition rewrite hotspots were left byte-for-byte
intact (OOS-3, see the "Hotspots C did NOT touch" section, which is the load-bearing
guarantee for sync).

### New files (C)

| New file | Content moved into it | Source it came from |
|:--|:--|:--|
| `packages/edit-runtime/src/viewport/viewport-gizmo-geometry.ts` (181 LOC) | Gizmo layout constants (`AXES` / `PLANES` / `RING_SEG` / `TIP_QUAT` / `DEG2RAD` / `PlaneHandle`), cone-mesh vertex builder (`buildConeMeshData`), and the pure dotted-wireframe point generators (`lightGizmoPoints` / `cameraGizmoPoints` + helpers `addSeg` / `circlePts` / `forwardOf`) | `viewport.ts` |
| `packages/edit-runtime/src/viewport/viewport-vag-bridges.ts` (326 LOC) | The VAG / console / network / diagnostics bridges (`installFpsReport`, `installConsoleBridge`, `installNetworkBridge`, `installPreviewControls`, `installErrorOverlay`, `paintDiagnosticMessage`, `isSpawnRef` / `isSpawnDoc` guards, install-once module flags) | `ViewportComponent.tsx` |

### Modified files (C)

| File | LOC before → after | What changed | What did NOT change |
|:--|:--|:--|:--|
| `viewport.ts` | 1009 → 931 | Added imports from `viewport-gizmo-geometry`; deleted the inline `AXES`/`PLANES`/`RING_SEG`/`TIP_QUAT`/`DEG2RAD` consts + `_v3` buffer; `ensureCone` now calls `buildConeMeshData()`; `updateParamGizmo`'s light/camera branches now call `lightGizmoPoints`/`cameraGizmoPoints`; `dragPlane` typed as `PlaneHandle` | `applyCamera` body incl. the `engine.set(camera, Transform, {...})` **camera pose write** (the ONE surgery point); `pick()` / `resolveEditorEntity`; the whole pointer/gizmo interaction state machine |
| `ViewportComponent.tsx` | 801 → 530 | Removed the six bridge functions (now imported from `viewport-vag-bridges`); dropped the now-unused VAG-schema + `setFps` + `broadcastAssetsChanged` imports; added the bridge import | `bootViewport`'s `createApp(...)` **wiring block** (createApp call, `gateway.doc.world`/`registry` injection, `engineFacade()` camera spawn, `initHostSession` wiring); the React component body |

## Hotspots C did NOT touch (OOS-3 guarantee for sync)

world-partition's semantic rewrite (same-function-body, per research RD3) lands on
these three points. C verified — via `git diff` — that its commit `e062724` touches
**none** of their bodies (only nearby imports/comments):

| Hotspot | Location (post-split) | world-partition intent | C's diff status |
|:--|:--|:--|:--|
| Camera pose write ("the ONE surgery point") | `viewport.ts` `applyCamera` → `engine.set(camera, Transform, {...})` (~L166) | rewrite the write to go through a super world handle | **NOT in C's diff** |
| `createApp` wiring | `ViewportComponent.tsx` `bootViewport` → `const app = await createApp(...)` (~L270) + `gateway.doc.world = world` | thread the booted world into the editor session via super | **NOT in C's diff** |
| `rayAABB` pick math | `viewport-ray.ts:54` (unchanged file) | (pick path) | **`viewport-ray.ts` has zero diff in C** |

## How to sync (second merger)

1. If **world-partition merges first**: C's finalize rebases the two new-file
   extractions on top of world-partition's rewritten `viewport.ts` /
   `ViewportComponent.tsx`. Because C only MOVED the clusters listed above (all
   disjoint from the three hotspots), the extraction re-applies cleanly: re-cut the
   same clusters into `viewport-gizmo-geometry.ts` / `viewport-vag-bridges.ts`, keep
   world-partition's hotspot rewrites verbatim.
2. If **C merges first** (this footprint's default assumption): world-partition
   rebases its hotspot rewrites onto C's split. The hotspots stayed in
   `viewport.ts` / `ViewportComponent.tsx` (not moved), so world-partition's diff
   still applies to the same lines; the only mechanical delta is the reduced
   surrounding context (gizmo geometry + bridges now imported, not inline).
3. **Equivalence net**: `viewport/__tests__/viewport-ray-math.test.ts` (C, w18)
   freezes the GOLDEN numeric contract of `rayAABB` / `angleOnAxis` / the orbit
   pose. After sync, this test must stay green — if world-partition's rewrite
   perturbs any of those values, that test goes red and flags the regression.

## Verification (C, w20 closeout, all green)

`bun run lint` · `bun run lint:dep` · `bun run typecheck` · `bun -F @forgeax/editor-edit-runtime test` (148 pass) · `bun -F @forgeax/platform-io test` (31 pass) · `bun run selfcheck:b2` (15 pass) · `bun run test:e2e e2e/smoke-boot-play.spec.ts` (1 pass) · `bun run test:e2e e2e/play-real-game-safety-net.spec.ts` (LIGHT pass, HEAVY skipped — needs wgpu-wasm) · cohesion `edit-runtime max_file_loc` 1010 → 931 (AC-08 drop).

Anchors: requirements AC-05 / AC-07 / AC-08 / AC-10 · plan-strategy §2 D-5 + §4 R-2 · research RD3.
