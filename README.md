<!-- LANG-SWITCH -->
**Language**: **English** · [简体中文](README.zh-CN.md)

> [!IMPORTANT]
> README is maintained in two languages ([`README.md`](README.md) canonical · [`README.zh-CN.md`](README.zh-CN.md) mirror). **Any change must update both in the same commit.**

---

# forgeax-editor

> forgeax editor monorepo — 5 workspace packages composing the full forgeax editor (Edit / Play dual-mode).

## Packages

| Package | Purpose |
|:--|:--|
| [`@forgeax/editor-core`](./packages/editor-core/) | Core logic layer — SceneDocument, EditorBus, undo/redo, schema, sync-channel, animation, material graph, assets, presets |
| [`@forgeax/editor-shared`](./packages/editor-shared/) | Cross-layer shared runtime — zustand store, entity ops, context menu, dock bridge, panel manifest SSOT |
| [`@forgeax/editor-panels`](./packages/editor-panels/) | 8 business panels (Hierarchy, Inspector, Assets, History, Capabilities, Material, Timeline, MaterialGraph) + panel-component injection |
| [`@forgeax/editor-edit-runtime`](./packages/edit-runtime/) | Edit-mode entry — engine boot + camera + dock shell + EditorApp |
| [`@forgeax/editor-play-runtime`](./packages/play-runtime/) | Play-mode thick host — FPS capture, physics gate, pack-index, diagnostics overlay, VAG_CONSOLE bridge |

## Dependency structure

```
editor-core  ←── editor-shared  ←── editor-panels  ←── editor-edit-runtime
    ↑
    └── editor-play-runtime          (iframe VAG_* protocol)
```

## Quick start

```bash
bun install            # install workspace deps
bun run typecheck      # tsc --noEmit across all packages
bun run lint:dep       # dependency-cruiser — assert the DAG has no cycle
```

## Run

The editor runs in two contexts. **Standalone** (this repo on its own) is the
everyday dev loop; **embedded** is how studio actually ships it.

### Standalone editor (recommended) — `:15290`

The standalone editor is a self-rendered React + DockShell chrome served by vite
with `root=standalone/`. It needs **two** servers wired together:

| Port | Server | Role |
|:--|:--|:--|
| **`:15290`** | standalone chrome host (vite, `root=standalone/`) | The page you open. Renders the dock shell; **proxies `/editor` → `:15280`** |
| **`:15280`** | `@forgeax/editor-edit-runtime` | Source of the panel + viewport iframes the shell injects |

One command starts both, wired correctly:

```bash
bun run dev:standalone        # → open http://localhost:15290
```

Then open **http://localhost:15290**.

> [!IMPORTANT]
> The crucial wiring is `FORGEAX_INTERFACE_PORT=15290`. edit-runtime's vite HMR
> `clientPort` defaults to `18920` (the studio-embed host). In standalone the
> host is `:15290`, so without this override the HMR websocket hammers a dead
> `:18920` and floods the console with `ERR_CONNECTION_REFUSED`.
> `bun run dev:standalone` (see [`scripts/dev-standalone.sh`](./scripts/dev-standalone.sh))
> sets it for you. Anchors: edit-runtime `vite.config.ts` `hmr.clientPort`,
> standalone `vite.config.ts` `server.proxy['/editor']`.

Need the two halves separately (e.g. to attach a debugger)?

```bash
bun run dev:edit-runtime      # :15280, HMR→15290 (FORGEAX_INTERFACE_PORT=15290 baked in)
bun run dev                   # :15290 standalone host only (expects :15280 already up)
```

### Play mode — `:15173`

```bash
bun -F @forgeax/editor-play-runtime dev        # → http://localhost:15173
```

`FORGEAX_ENGINE_PORT` overrides the port (default `15173`).

### Embedded in studio — `:18920`

When consumed by the studio monorepo (editor is a git submodule at studio's
`packages/editor`), the editor renders inside the studio host on `:18920` and
the edit-runtime HMR `clientPort` default (`18920`) is already correct. **Do not
start the standalone stack for this** — start the full studio stack instead
(`bash scripts/deploy.sh` once for environment, then `bash start.sh`).

### Port map

| Port | Who | When |
|:--|:--|:--|
| `15290` | standalone chrome host | `bun run dev:standalone` / `bun run dev` |
| `15280` | edit-runtime (Edit mode) | `bun run dev:standalone` / `bun run dev:edit-runtime` |
| `15173` | play-runtime (Play mode) | `bun -F @forgeax/editor-play-runtime dev` |
| `18920` | studio-embed host | full studio stack (studio repo) |
| `18900` | forgeax-server | full studio stack (studio repo) |

> [!NOTE]
> forgeax-editor is a standalone git repo (`https://github.com/ForgeaXGame/forgeax-editor`)
> consumed by the studio repo as a git submodule at `packages/editor`. All 5
> packages point their `exports` directly at source entries (`./src/index.ts`)
> with no tsup build step — the consumer's bundler (vite) compiles them on the
> spot.

## known limitations (baseline as of 2026-06-13)

These capabilities carry over from P2 and are explicitly documented as
**not passing under the current sandbox/standalone test environment**.
They are tracked for a future full-studio regression sweep.

| Capability | What it tests | Status | Constraint |
|:--|:--|:--|:--|
| AC-15B panel-mount e2e (P2 G-4) | panel mount on standalone chrome surface | deferred — `test.skip` in `standalone-chrome.spec.ts` | requires full studio harness with `ANTHROPIC_API_KEY` and running `forgeax-server` on :18900; unreachable under standalone/sandbox |
| AC-16 producer-side z.infer fixup | producer-call-site strong type equivalence | deferred — P2 AC-16 carry-over from implement R3 reviewer accept-risk | requires `protocol.ts` SSOT relocation + full `z.infer` re-application across all producer call sites; tracked as OQ-1 for P3 |

These are not regressions — they were never green in the standalone
configuration. They will be re-validated once a `forgeax-server` instance
with valid credentials is available in the test environment, or when the
P3 SSOT-relocation loop closes the OQ-1 gap.

## troubleshooting

| Symptom | Cause | Fix |
|:--|:--|:--|
| Console floods with `ERR_CONNECTION_REFUSED` to `:18920` on `:15290` | started the standalone host without `FORGEAX_INTERFACE_PORT=15290`, so edit-runtime HMR targets the studio-embed port | use `bun run dev:standalone` (or `bun run dev:edit-runtime`), not a bare `bun -F …edit-runtime dev` |
| `:15290` viewport / panels are blank | `:15280` edit-runtime not running; the `/editor` proxy has nothing to hit | start both servers — `bun run dev:standalone` |
| `bun install` reports `unresolved workspace` | engine submodule not fetched or `workspace:*` pin broken | verify the relative path to the engine submodule; stacks resolve via the parent repo's bun workspaces glob |
| `bun run typecheck` fails | a package's deps aren't installed or types mismatch | run `bun install` first, then `bun run typecheck` |
| `bun run lint:dep` reports no-circular | a new cross-package import broke the DAG | check `.dependency-cruiser.cjs` rules; keep the DAG `core ← shared ← panels ← edit-runtime` |
| port `15290` / `15280` / `15173` in use | another vite instance wasn't stopped | `bash stop.sh` (studio repo) or manually `kill` the PID |
