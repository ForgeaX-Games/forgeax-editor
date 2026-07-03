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

For the **full standalone stack** (`bun run setup` → `bun run start --game <dir>`), `setup` also builds the engine's two gitignored wasm artefacts (zero-binary invariant):
- **wgpu-wasm** (`pkg/wgpu_wasm_bg.wasm`) — needs Rust + `wasm-pack`.
- **fbx-wasm** (`pkg/fbx-wasm.{mjs,wasm}`) — needs **Emscripten `emcc`** (`brew install emscripten`, or emsdk). Without it `setup` errors with the install command; the editor's browser FBX import stays unavailable until built (glTF unaffected).

Both are rebuilt on demand — never committed. A bare `bun install` alone does NOT build them; use `bun run setup` (or `bun -F @forgeax/engine-fbx-wasm build:wasm`).

## Commands

| Task | Command |
|:--|:--|
| Typecheck (all packages) | `bun run typecheck` (`tsc --noEmit`) |
| Full lint | `bun run lint` (sync-channel + api-seam gates) |
| Dependency-cycle gate | `bun run lint:dep` (dependency-cruiser — asserts the DAG) |
| Standalone dev (recommended) | `bun run dev:standalone` → http://localhost:15290 |
| Edit-runtime only | `bun run dev:edit-runtime` (:15280, HMR→15290) |
| Standalone host only | `bun run dev` (:15290, expects :15280 up) |
| Play mode | `bun -F @forgeax/editor-play-runtime dev` → :15173 |
| Self-boot B2 gate (the CI gate) | `bun run selfcheck:b2` |
| E2E (Playwright) | `bun run test:e2e` (install browser once: `bun run test:e2e:install`) |
| Single E2E spec | `bun run test:e2e e2e/<name>.spec.ts` (or `-g "<test name>"`) |
| Unit test one package | `bun -F @forgeax/<pkg> test` (e.g. `bun -F @forgeax/platform-io test`) |
| CLI dev-stack | `bun run setup` (install) · `bun run start` (run) · `bun run stop` |

> **Port map:** `15290` standalone chrome host · `15280` edit-runtime · `15173` play-runtime · `18920` studio-embed host · `18900` forgeax-server (studio-only). Standalone wiring **requires** `FORGEAX_INTERFACE_PORT=15290` so edit-runtime HMR doesn't hammer the dead studio port `:18920` — `dev:standalone` sets it for you; a bare `bun -F …edit-runtime dev` will flood the console with `ERR_CONNECTION_REFUSED`.

## Architecture

Five workspace packages forming an **acyclic DAG** — `bun run lint:dep` fails the build if any import breaks it:

```
engine ← editor-core ← editor-shared ← editor-panels ← edit-runtime
                                                        play-runtime  (separate thick host)
```

| Package | Role |
|:--|:--|
| `@forgeax/editor-core` | Core logic — EditSession, EditorBus, undo/redo, schema, sync-channel, animation, material graph, assets, presets, sockets, the injected **ApiClient** backend seam |
| `@forgeax/editor-shared` | Cross-layer runtime — zustand store, entity ops, context menu, dock bridge, **panel manifest SSOT** |
| `@forgeax/editor-panels` | 8 business panels (Hierarchy, Inspector, Assets, History, Capabilities, Material, Timeline, MaterialGraph) + panel-component injection |
| `@forgeax/editor-edit-runtime` | Edit-mode entry — engine boot + camera + dock shell + EditorApp |
| `@forgeax/editor-play-runtime` | Play-mode **thick host** — FPS capture, physics gate, pack-index, diagnostics overlay. Talks to `core` **only** over the `VAG_*` iframe protocol (dashed edge — no direct import) |

**Top-level `src/` entries** (the published surface) are deliberately thin pass-throughs — `edit.ts`/`play.ts`/`protocol.ts`/`app-kit.ts` re-export from sub-packages. `src/index.ts` is **zero-transitive** on purpose: it imports only `defineApp` and the `EDITOR_PANELS` const via a *relative* path into editor-shared/manifest, avoiding the barrel that would drag the whole engine chain into scope under bun's `file:` resolution. Don't "clean this up" into a normal barrel import — the relative path is intentional.

## Invariants agents must respect (CI-enforced)

1. **No import cycles.** Keep the DAG `core ← shared ← panels ← edit-runtime`. New cross-package import broke it? Fix the direction, don't add to `.dependency-cruiser.cjs`.
2. **Backend only through the injected `ApiClient`** (`editor-core/src/api-client.ts`). A raw `fetch('/api/...')` in editor-proper source re-hardcodes the transport and trips `lint:api-seam`. Use `getApiClient().fetch(...)`. (`packages/interface`, `api-client.ts` itself, and tests are exempt.)
3. **EDITOR_PANELS is duplicated** between `editor-core/src/manifest.ts` (SSOT) and `editor-core/src/sync-channel.ts` (inline copy — the inline copy avoids a shared→core cycle). `lint:sync-channel` guards drift; if you edit one, edit both in the same order.
4. **Single engine world.** The one edit-runtime world hosts both editor and game systems. `lint-no-second-world.mjs` (diff-scoped) forbids a feature from adding a net-new `new World()` / `createWorld()`.
5. **VAG protocol SSOT** lives in `editor-core/src/protocol.ts` (16 `VAG_*` schemas). play-runtime reaches core only through it — never via direct import.
6. **README is bilingual.** Any change to `README.md` must update `README.zh-CN.md` in the same commit.

## Self-boot levels

CI (`.github/workflows/ci.yml`) re-proves on every push/PR that a fresh `clone → bun install` reaches **B2**: the standalone editor reads **and writes** a game with **no studio server**, by reusing `@forgeax/platform-io` (the real 后L1 file router, confined to one game) as its backend — see `standalone/game-backend.ts`. The B2 gate is deliberately lightweight (no engine/Rust-wasm build); heavier gates (typecheck, api-seam, e2e, engine build) live in the studio superrepo CI.

## Anti-patterns when extending the editor

These are distilled from real regressions in this repo. The editor's job is to *author* — project business intent onto the engine's real components — not to *reimplement* the engine. Most editor bugs come from crossing that line.

1. **Don't hand-roll a capability the engine already has.** The editor has accreted "escape hatches" — a private GLB parser, placeholder cubes, duplicate spawn loops, an editor-only `GltfRef` component — that duplicate engine primitives or silently diverge from them. Before writing engine-shaped logic (parsing, transform math, spawning, asset resolution), grep the engine submodule first. When the engine *almost* has it, the right fix is usually **one engine export or one contract field**, then converge the editor onto it — not a parallel implementation in editor source. Hand-rolls are historical debt, not design intent; don't add to the pile.

2. **Authoring data must round-trip, or it's a data-loss bug.** An authoring component that `scene-pack` can't persist saves as an empty node — geometry silently disappears on reopen and never reaches Play (the `GltfRef` failure). Anything you add to the authoring layer must survive the full loop: **session → pack → reopen → Play**. "Works in Edit" is not done; **Edit must equal Play**. Placeholder cubes, drop-on-save, and read-only-single-axis are all Edit≠Play smells.

3. **Prefer expressing intent as a native scene over inventing a parallel format.** Before adding a new component + `*.json` format + loader, ask whether the engine's scene/ECS already expresses it losslessly. A "socket / attach point" is not a new concept — it's a prop as `ChildOf(bone) + Transform`, which a scene entity already encodes; the transform propagates for free each frame. Inventing a `Socket` component + `socket.json` duplicates what the scene already holds (violates SSOT / Derive). **The output should be a scene, not a sidecar format.**

4. **Check whether the "feature" is just a usage of existing primitives before building a tool.** The scene editor already has a hierarchy tree, drag-to-reparent, and a Transform panel. A whole new editor panel is rarely warranted when the composition is three mouse operations on existing UI. Build the *genuinely missing* piece (e.g. a viewport animation-clip scrubber) — not a redundant DCC surface around it.

5. **Verify engine symbols exist before importing them.** A shipped commit imported `Socket` / `applySocket` from `@forgeax/engine-runtime` — symbols that don't exist — so the code crashed at runtime on `addComponent({ component: undefined })`. The engine is a submodule you can read: `git grep <symbol> packages/engine` before depending on it. Fail fast at authoring time, not at the user's runtime.

6. **Nail down cross-repo unit/order conventions explicitly.** The editor stores rotations as Euler XYZ degrees; the engine `Transform` stores quaternions. The conversion must *actually happen* on the editor side (not deferred to a phantom engine system) and the order (XYZ) must be pinned on both sides. This is a recurring bug class (Euler-treated-as-quaternion, read-only single axis) — the conversion seam is where round-trip fidelity is won or lost.

## Conventions

- TypeScript `strict` + `noUncheckedIndexedAccess`; `moduleResolution: bundler`; React 19 (`jsx: react-jsx`).
- Source files carry dense header comments anchoring to requirements/plan IDs (`AC-xx`, `plan-strategy §…`). Match that density when editing; the anchors are the traceability contract, not noise.
- `.forgeax-harness/` is a **gitignored floating clone** (not a submodule) of forgeax-editor-harness, materialized by `scripts/sync-harness.mjs` on postinstall. It carries closed-loop state; leave it out of editor commits.
