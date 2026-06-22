# ForgeaX Studio — forgeax-editor

[English](./README.md) · [简体中文](./README.zh-CN.md) · [↑ studio](https://github.com/ForgeaX-Games/forgeax-studio)

> **The visual scene editor — direct-manipulation editing and real-engine play of the same scene, built as a strictly-layered five-package monorepo.**

`forgeax-editor` is the what-you-see-is-what-you-play scene editor that Studio embeds. It is not
a mock viewport: **Edit** mode gives you a hierarchy, inspector, asset browser, material graph,
and timeline over a real `SceneDocument`, while **Play** mode boots the *actual* engine
(physics, FPS capture, diagnostics) on the same scene. Because both read the same on-disk scene,
what you edit is exactly what plays.

## Why it matters

- **Edit and Play, one scene, no drift.** Both modes operate on the same disk-backed scene, so
  there is no "export to test" round trip — flip to Play and you're inside the running game,
  flip back and your edits are intact.
- **Play is an isolated thick host.** Play mode runs as a separate runtime that talks to the
  editor core **only over a typed iframe message protocol**. A crash or a runaway frame in the
  running game can't take the editor down — the boundary is a protocol, not shared memory.
- **The architecture is enforced, not aspirational.** The packages form a strict dependency DAG
  — `editor-core ← editor-shared ← editor-panels ← edit-runtime` — and `bun run lint:dep`
  (dependency-cruiser) **fails the build** if any import violates it. Layering you can rely on.
- **A real document model.** `editor-core` ships `SceneDocument`, an `EditorBus`, undo/redo, a
  schema, a sync-channel, animation, and a material graph — the substrate a serious editor needs,
  not a bag of ad-hoc state.
- **It embeds the real engine.** Edit-mode boots the engine for the viewport; Play-mode boots it
  as a full host — so materials, lighting, and physics look in the editor exactly as they do in
  the shipped game.

## The five packages

| Package | Role |
|:--|:--|
| `@forgeax/editor-core` | core logic — `SceneDocument`, `EditorBus`, undo/redo, schema, sync-channel, animation, material graph, assets, presets |
| `@forgeax/editor-shared` | cross-layer runtime — Zustand store, entity ops, context menu, dock bridge, panel-manifest SSOT |
| `@forgeax/editor-panels` | the 8 panels — Hierarchy · Inspector · Assets · History · Capabilities · Material · Timeline · MaterialGraph — plus panel-component injection |
| `@forgeax/editor-edit-runtime` | Edit-mode entry — engine boot + camera + dock shell + `EditorApp` |
| `@forgeax/editor-play-runtime` | Play-mode thick host — FPS capture, physics gate, pack-index, diagnostics overlay |

Five entry points (`.` / `./edit` / `./play` / `./panels` / `./protocol`) let consumers pull in
exactly the layer they need.

## Key concepts

`SceneDocument` + `EditorBus` (document model + event bus) · undo/redo + sync-channel ·
the 8 panels + dockable shell · disk-SSOT Edit↔Play sync · Play as an isolated iframe-protocol
host · the enforced `core ← shared ← panels ← edit` DAG.

## How it fits the studio

Studio mounts the editor for direct-manipulation scene work alongside the chat-driven flow: Forge
can author a scene in code, and you can refine it visually in the editor — both writing to the
same scene on disk, both rendered by the same engine. Switching to Play runs it for real.

## Run (standalone)

First clone must fetch submodules — the editor vendors the engine and interface under
`packages/`.

```bash
bun install
bun dev            # the editor (Edit + Play)
bun run lint:dep   # verify the layering DAG holds
bun run test:e2e   # Playwright end-to-end
```

---

Part of the **ForgeaX Studio** monorepo. This repo is a submodule of
[`ForgeaX-Games/forgeax-studio`](https://github.com/ForgeaX-Games/forgeax-studio) — clone that
with `--recurse-submodules` to run the full studio. License: Apache-2.0.
