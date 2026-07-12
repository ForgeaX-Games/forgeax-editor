# AGENTS.md

Guidance for AI agents working in **forgeax-editor** — the forgeax editor monorepo (Edit / Play dual-mode). Companion `README.md` / `README.zh-CN.md` cover human-facing setup; this file is the fast-path for agents.

## Repo shape

- A **standalone git repo** (`github.com/ForgeaXGame/forgeax-editor`) that studio consumes as a git submodule at `packages/editor`. It must behave as if studio does not exist next to it — the "clone 即跑" promise is CI-gated, not a slogan.
- **Package manager is `bun`** (bun workspaces), not npm/pnpm. Workspaces glob: `packages/*`, `packages/engine/packages/*`.
- **No build step.** All packages point `exports` directly at source (`./src/index.ts`); the consumer's bundler (vite) compiles them in place. `bun run build` is a no-op.
- **Submodules are load-bearing.** `packages/engine`, `packages/interface`, `packages/platform-io`, and `forgeax-editor-assets` are git submodules. An empty submodule dir makes `bun install` fail with `Workspace dependency "@forgeax/interface" not found`. Always `git submodule update --init --recursive` on a fresh clone before `bun install`.

## Setup

```bash
git submodule update --init --recursive   # REQUIRED first — fetch engine/interface/platform-io/assets
bun install                               # if it fails with simple-git-hooks ENOENT, just re-run once
```

For the **full standalone stack** (`bun fx setup` → `bun fx start --game <dir>`), `setup` also builds the engine's two gitignored wasm artefacts (zero-binary invariant):
- **wgpu-wasm** (`pkg/wgpu_wasm_bg.wasm`) — needs Rust + `wasm-pack`.
- **fbx-wasm** (`pkg/fbx-wasm.{mjs,wasm}`) — needs **Emscripten `emcc`** (`brew install emscripten`, or emsdk). Without it `setup` errors with the install command; the editor's browser FBX import stays unavailable until built (glTF unaffected).

Both are rebuilt on demand — never committed. A bare `bun install` alone does NOT build them; use `bun fx setup` (or `bun -F @forgeax/engine-fbx build:wasm` — the collapse-fbx-to-ufbx refactor folded the old `engine-fbx-wasm` package into `engine-fbx`).

## Commands

| Task | Command |
|:--|:--|
| Typecheck (all packages) | `bun run typecheck` (`tsc --noEmit`) |
| Full lint | `bun run lint` (sync-channel + engine-shim + no-second-world gates) |
| Dependency-cycle gate | `bun run lint:dep` (dependency-cruiser — asserts the DAG and direction rules) |
| Standalone dev (recommended) | `bun run dev:standalone` → http://localhost:15290 |
| Edit-runtime only | `bun run dev:edit-runtime` (:15280, HMR→15290) |
| Standalone host only | `bun run dev` (:15290, expects :15280 up) |
| Play mode | `bun -F @forgeax/editor-play-runtime dev` → :15173 |
| Self-boot B2 gate (the CI gate) | `bun run selfcheck:b2` |
| E2E (Playwright) | `bun run test:e2e` (install browser once: `bun run test:e2e:install`) |
| Single E2E spec | `bun run test:e2e e2e/<name>.spec.ts` (or `-g "<test name>"`) |
| Unit test one package | `bun -F @forgeax/<pkg> test` (e.g. `bun -F @forgeax/platform-io test`) |
| CLI dev-stack (`bun fx`) | `bun fx setup` · `bun fx start [--play\|--game DIR\|--bg\|--rhi-debug]` · `bun fx stop` · `bun fx update [--dry-run\|--no-stash]` (pull root + sync submodules to pins + ff `.forgeax-harness`) · `bun fx clean [--deep\|--dry-run]` (restore clean git status across root + submodules) · `bun fx help`. Entry is TypeScript `scripts/fx.ts` (run by bun), mirroring forgeax-studio's `bun fx` vocabulary; `setup`/`start`/`stop`/`update`/`clean` are also reachable as `bun run <verb>`. Typechecked in CI via `scripts/tsconfig.json` (`bun run typecheck:scripts`). |

> **Port map:** `15290` standalone chrome host · `15280` edit-runtime · `15173` play-runtime · `18920` studio-embed host · `18900` forgeax-server (studio-only). Standalone wiring **requires** `FORGEAX_INTERFACE_PORT=15290` so edit-runtime HMR doesn't hammer the dead studio port `:18920` — `dev:standalone` sets it for you; a bare `bun -F …edit-runtime dev` will flood the console with `ERR_CONNECTION_REFUSED`.

## Architecture

Five workspace packages forming an **acyclic DAG** — `bun run lint:dep` fails the build if any import breaks it:

```
engine ← editor-core ← editor-content-browser ← editor-panels ← edit-runtime
                                                                           play-runtime  (separate thick host)
```

| Package | Role |
|:--|:--|
| `@forgeax/editor-core` | Core logic — EditSession, EditorBus, undo/redo, schema, sync-channel, animation, material graph, assets, presets, sockets; backend calls = same-origin relative `/api` platform `fetch`; persistence/host DI is injected via `deps.fetch` (fakeable) |
| `@forgeax/editor-content-browser` | Asset browser — grid/list/column views, filter/sort/history, drag-spawn, import pipeline (FBX/glTF cook via core) |
| `@forgeax/editor-panels` | business panels (Hierarchy, Inspector, Assets, History, Capabilities, Mesh, …) + panel-component injection. The canonical live list is `EDITOR_PANELS` in `editor-core/src/manifest.ts` (invariant 3) — read it rather than trusting this prose |
| `@forgeax/editor-edit-runtime` | Edit-mode entry — engine boot + camera + dock shell + EditorApp |
| `@forgeax/editor-play-runtime` | Play-mode **thick host** — FPS capture, physics gate, pack-index, diagnostics overlay. Talks to `core` **only** over the `VAG_*` iframe protocol (dashed edge — no direct import) |

**Top-level `src/` entries** (the published surface) are deliberately thin pass-throughs — `edit.ts`/`play.ts`/`protocol.ts`/`app-kit.ts` re-export from sub-packages. `src/index.ts` is **zero-transitive** on purpose: it imports only `defineApp` and the `EDITOR_PANELS` const via a *relative* path into editor-core/manifest, avoiding the barrel that would drag the whole engine chain into scope under bun's `file:` resolution. Don't "clean this up" into a normal barrel import — the relative path is intentional.

## Invariants agents must respect (CI-enforced where noted)

1. **No import cycles + direction rules.** Keep the DAG `core ← content-browser ← panels ← edit-runtime`. `bun run lint:dep` (dependency-cruiser) enforces both no-circular and upward-import direction rules. New cross-package import broke it? Fix the direction, don't add to `.dependency-cruiser.cjs`.
2. **Backend calls use platform `fetch`; DI via `deps.fetch`.** All editor backend calls go through same-origin relative `/api` platform `fetch`. Persistence and host subsystems accept `deps.fetch` as an injectable `(path: string, init?: RequestInit) => Promise<Response>` — the fakeable DI point. Bare `fetch(` in editor source means platform-direct; `deps.fetch(` means injectable (test substitutes).
3. **EDITOR_PANELS is single-SSOT** in `editor-core/src/manifest.ts`. `lint-sync-channel-panels.mjs` (wired into `bun run lint`) asserts that no other file defines a duplicate `EDITOR_PANELS` literal — any second copy trips CI.
4. **Single engine world.** The engine submodule (on-disk lib) must not grow a second engine World — `lint-no-second-world.mjs` scans `git -C packages/engine diff` to gate that. Editor-side `new World()` calls (e.g. `play-assemble.ts` level-load world, plan-strategy D-1/D-2) are legitimate: play mode creates a separate **transient** playWorld (fresh `new World()` + level-load) whose lifetime is the play session (stop drops it, no persistence), while the single persistent editWorld stays untouched. The gate's scanning domain is the engine submodule only — editor source (`packages/core`, `packages/edit-runtime`, etc.) is out of scope by design.
5. **VAG protocol SSOT** lives in `editor-core/src/protocol.ts` (16 `VAG_*` schemas). play-runtime reaches core only through it — never via direct import (convention — not machine-enforced; `bun run lint:dep` direction rules prevent wrong-direction imports but do not gate the VAG protocol path specifically).
6. **README is bilingual.** Any change to `README.md` must update `README.zh-CN.md` in the same commit (convention — not machine-enforced; reviewers gate this in PR review).
7. **All editor state mutation goes through the EditGateway — one door.** Every state-changing operation is a `gateway.dispatch(op, origin?)` (immediate) / `gateway.begin→update→commit/cancel` (continuous gesture) call, or a downstream `registerSessionApplier(kind, applier)` seam registration. Human UI handlers and AI code use the **same** gateway, same op payload, same applier, same ledger (human-machine isomorphism). The three domains are decided *structurally* by which applier table registers the kind — `document` (undo + ledger), `session` (ledger only, irreversible), `transient` (neither) — never by a hand-pasted label. Consequences agents must respect:
   - **Never mutate `world` / `EditSession` / a `store/` setter directly from a UI package** (`panels` / `content-browser` / `edit-runtime` / `standalone`). Importing a `store/` setter to write (`import { setSelection } from '.../store/selection'`) is a violation; reading via hooks/Derive/`gateway.activeWorld` is fine. Direct `world.set(...)` in a panel handler is a violation — route it through a `setComponent`/domain op instead. (This is exactly the `Material.tsx` regression that got the panel deleted, and the `systems-panel` `world.addSystem`/`removeSystem` bypass that moved behind a session-applier seam.)
   - **Continuous gestures (gizmo drag, slider scrub) use `begin→update→commit`**, not per-frame direct writes — one undo entry per gesture, not one per tick.
   - **New operation? Add an applier, don't scatter a setter.** Document/session ops register via `registerApplier`/`registerSessionApplier` in core (or edit-runtime for engine-scoped session ops like `play`/`stop`/`addSystem`); reuse the existing facade primitives (`ctx.assetIO.*`, `ctx.engine.*`) inside the applier rather than hand-rolling I/O (see anti-pattern #1). Composable read-only-plan ops can use `gateway.defineOp`.
   - **CI gate:** `scripts/lint-op-via-gateway.mjs` (in `bun run lint`) is **diff-scoped** — it blocks *new* bare `store/` setters and *new* direct-setter imports in UI packages, but does NOT prove the existing tree is fully converged; when auditing, snapshot the whole surface, don't trust the gate's silence. Documented exemptions: `ref-request.ts` / `mesh-stats.ts` / `assets-changed.ts` / `disk-watch.ts`, plus `init*`/`bootstrap*` and `create*Context` / `create<Thing>(deps:…)` DI factories.
   - **Known by-design escape hatch (not a violation):** nested GLB scene instantiation (`scene/spawn-asset-ref.ts` → `store/persistence/disk-io.ts`) writes the subtree into the world directly and signals via `notifyDocChanged()`. The authored fact is the single `SceneInstance` ref on the wrapper (which *is* gateway-spawned and round-trips as one `mounts[]` entry); the subtree is a **derived cache** re-expanded on load, deliberately kept out of the ledger. Don't try to ledger individual member entities — that duplicates the engine's SceneInstance SSOT.
   - **Skill reference:** `forgeax-editor-gateway` (the `/forgeax-editor-gateway` skill + `docs/skills/forgeax-editor-gateway.md`) is the authoritative API/mental-model doc — read it before building editor tools or AI-driven editing.

## Design principles (the *why* behind invariant 7)

> Invariant 7 is the mechanic; these are the axioms it enforces — review razors for any "make AI able to do X" change. Long-form: harness KB `wiki/editor-operation-ssot-north-star.md`, `editor-architecture.md`, `editor-panel-realm-architecture.md`.

1. **Editor = operation platform; AI = its first user** — not "UI handlers on top of the engine." What a human can do and what an AI can do are *the same set by construction*: peer callers of one door, not "human owns the full set, AI a registered subset." The design question is always "is this one op a button and an AI both dispatch?" — never "how do I *also* expose this to AI?"

2. **One door = two axes — hold both or you misclassify.**

   | Axis | Monopoly | Guarantees |
   |:--|:--|:--|
   | Ledger entry (`gateway.dispatch`) | authored intent has one origination point | audit / collaborate / undo |
   | Write-gate (`ctx.engine` facade) | every world mutation exits one proxy; op code can't obtain a raw `world` | constrained mutation |

   **write-gate ⊇ ledger.** Every op runs through the write-gate; not every write is an op. Forcing example: **camera orbit** writes `world` every frame (write-gate) but isn't artwork (must not enter ledger). Collapse the axes into one word and camera has nowhere to live.

3. **Chrome-vs-authored litmus:** *"Should this save into scene-pack / appear in Play?"* YES → authored → must be a `dispatch` op (ledger/undo/trace/AI-visibility for free). NO → chrome → write-gate only. Collaboration sub-test: "must the other party *see* me do it?" yes → at least a session op. "Viewport scaffold" is a leaky label — run each element through the litmus, don't trust the label. (KB case: boot-time skylight `world.spawn` is authored — Play reads env light from the pack — so it's `spawnEntity`+`setComponent`, not a scaffold write. Anti-pattern #1 in a gateway costume.)

4. **Registry razor** — sharpest test for any "let AI use X":

   > *Is this code **creating** a capability (one op, human+AI both dispatch it), or **registering an AI-copy** of a capability whose real body is a human `onClick`/closure?*

   Creating = single-door, alignment structural. Registering a copy = the anti-pattern: alignment by discipline, entropy drifts human-only (forget to register → the op *silently* vanishes for AI, still works for humans). Implementation form: *can the framework compute the inverse and replay it headless?* Yes → an op (`plan(query,args) → EditorOp[]`, data through one interpreter). No → a UI-bound side-effect (`run(args) → void`, black-box, no inverse) = an *action*. Healthy end-state isn't "delete the registry" — a registry does what the gateway can't (cross-iframe transport, `exposedToAI`/`requireConfirm` gating); it must *project* gateway ops (`listOps()`-derived manifest), never *create* them.

5. **Single-door beats registry by non-symmetry, not preference.** Registry: misalignment is default, alignment costs continuous discipline (forget AI → AI silently degrades). Single-door: alignment is default, misalignment is unbuildable (forget a path → the human's own button breaks first, so it's fixed on the spot). Why engine survives on a bare `eval` floor but the editor can't: editor ops carry three dimensions engine's don't — UI intent (discoverable / nameable / bindable), undo (needs an inverse), collaboration (ledger reads "AI parented X under Y", not opaque source). The editor's equal-access floor is a full semantic command surface with UI on top; `eval` is a devtools-tier escape hatch, not the spine.

6. **Panels share one realm — never rebuild engine capability behind an isolation boundary.** Deepest historical bug class: per-panel iframe → "dead world" (`world=null`) → the panel rebuilds what the engine has (`_popoutCache` shadow World; `loadGameAssets` parallel disk-scan instead of the engine `AssetRegistry`). Two parses of one disk drift silently. Fix: inject panels as React components sharing one realm / World / registry (DI slot to dodge the import cycle). **A docked panel reads the live `world`/`registry` directly; it never re-derives engine state across a boundary.** Pop-out (a real separate OS window) is the only physically cross-realm case — defer it; when built, layer by real need (metadata → projection; asset-render → dedicated preview mini-world), never a one-size iframe.

7. **Entity identity = engine `EntityHandle`, full stop.** No second id namespace, no `_e2h`/`_h2e`/`_nextId` dual-identity map (`localId` lives *only* at the serialization boundary, never read back as live identity). Handles don't cross play/stop (play = fresh `new World()` + level-load; stop = drop it; the persistent editWorld is frozen during play — UE's PIE two-world model). Stale/cross-boundary access returns a **structured** error (`entity-state-stale-handle` / `edit-rejected-in-play`), never silently resolves to the wrong entity (charter P3).

## Self-boot levels

CI (`.github/workflows/ci.yml`) re-proves on every push/PR that a fresh `clone → bun install` reaches **B2**: the standalone editor reads **and writes** a game with **no studio server**, by reusing `@forgeax/platform-io` (the real 后L1 file router, confined to one game) as its backend — see `standalone/game-backend.ts`. The B2 gate is deliberately lightweight (no engine/Rust-wasm build); heavier gates (typecheck, e2e, engine build) live in the studio superrepo CI.

## Anti-patterns when extending the editor

These are distilled from real regressions in this repo. The editor's job is to *author* — project business intent onto the engine's real components — not to *reimplement* the engine. Most editor bugs come from crossing that line.

1. **Don't hand-roll a capability the engine already has.** The editor has accreted "escape hatches" — a private GLB parser, placeholder cubes, duplicate spawn loops, an editor-only `GltfRef` component — that duplicate engine primitives or silently diverge from them. Before writing engine-shaped logic (parsing, transform math, spawning, asset resolution), grep the engine submodule first. When the engine *almost* has it, the right fix is usually **one engine export or one contract field**, then converge the editor onto it — not a parallel implementation in editor source. Hand-rolls are historical debt, not design intent; don't add to the pile.

2. **Authoring data must round-trip, or it's a data-loss bug.** An authoring component that `scene-pack` can't persist saves as an empty node — geometry silently disappears on reopen and never reaches Play (the `GltfRef` failure). Anything you add to the authoring layer must survive the full loop: **session → pack → reopen → Play**. "Works in Edit" is not done; **Edit must equal Play**. Placeholder cubes, drop-on-save, and read-only-single-axis are all Edit≠Play smells.

3. **Prefer expressing intent as a native scene over inventing a parallel format.** Before adding a new component + `*.json` format + loader, ask whether the engine's scene/ECS already expresses it losslessly. A "socket / attach point" is not a new concept — it's a prop as `ChildOf(bone) + Transform`, which a scene entity already encodes; the transform propagates for free each frame. Inventing a `Socket` component + `socket.json` duplicates what the scene already holds (violates SSOT / Derive). **The output should be a scene, not a sidecar format.**

4. **Check whether the "feature" is just a usage of existing primitives before building a tool.** The scene editor already has a hierarchy tree, drag-to-reparent, and a Transform panel. A whole new editor panel is rarely warranted when the composition is three mouse operations on existing UI. Build the *genuinely missing* piece (e.g. a viewport animation-clip scrubber) — not a redundant DCC surface around it.

5. **Verify engine symbols exist before importing them.** A shipped commit imported `Socket` / `applySocket` from `@forgeax/engine-runtime` — symbols that don't exist — so the code crashed at runtime on `addComponent({ component: undefined })`. The engine is a submodule you can read: `git grep <symbol> packages/engine` before depending on it. Fail fast at authoring time, not at the user's runtime.

6. **Nail down cross-repo unit/order conventions explicitly.** The editor stores rotations as Euler XYZ degrees; the engine `Transform` stores quaternions. The conversion must *actually happen* on the editor side (not deferred to a phantom engine system) and the order (XYZ) must be pinned on both sides. This is a recurring bug class (Euler-treated-as-quaternion, read-only single axis) — the conversion seam is where round-trip fidelity is won or lost.
7. **Keyboard shortcuts live in ONE place.** Global editor keyboard handling belongs exclusively in `global-shortcuts.ts` (the `interface` submodule, `forgeax-interface.git`) — the single `window.addEventListener('keydown', …, capture)` listener. Do NOT add per-panel `document.addEventListener('keydown', …)` or `window.addEventListener('keydown', …)` listeners (the lint gate `lint-single-keydown-router` fails the build on any such global hook). Per-panel JSX `onKeyDown={…}` is allowed (scoped to the element, e.g. rename inputs / palette focus / modal Escape). Editor-specific shortcuts (Delete/Backspace/F2/Ctrl+D/Ctrl+A/G) are injected into that router via `registerKeyboardRouterDeps(...)` from `standalone/main.tsx` — the router stays editor-agnostic and routes every gesture through `gateway.dispatch` (one door, AI-equal). The router's `lastSelectionDomain` Derive (also exposed as `useLastSelectionDomain` from `@forgeax/editor-core`) is the single source for "which panel Delete governs" — read it for UI hints, don't maintain a second copy.

## Conventions

- TypeScript `strict` + `noUncheckedIndexedAccess`; `moduleResolution: bundler`; React 19 (`jsx: react-jsx`).
- Source files carry dense header comments anchoring to requirements/plan IDs (`AC-xx`, `plan-strategy §…`). Match that density when editing; the anchors are the traceability contract, not noise.
- `.forgeax-harness/` is a **gitignored floating clone** (not a submodule) of forgeax-editor-harness, materialized by `scripts/sync-harness.mjs` on postinstall. It carries closed-loop **and solo-loop** state; leave it out of editor commits.
- **Self-evolution loop:** the mounted **`forgeax-solo`** skill runs an autonomous dogfood → fix → verify → codify → ship loop toward a repo-defined roadmap (North Star: *author & ship a 3A-grade game*). Its products live in the harness clone under `.forgeax-harness/solo/`: `AGENTS.md` (how to boot/drive/verify/ship the editor — the loop's tool-mechanics SSOT), `LESSONS.md` (accumulated method anti-patterns), and `3a-game/` (`ROADMAP.md` pillar map, `PROGRESS.md` run ledger, `experiments/<run>/` notebooks). Invoke with `/forgeax-solo 3a-game`; each round drives the editor through the `forgeax-editor-gateway` front door and lands its fix as its own PR.
