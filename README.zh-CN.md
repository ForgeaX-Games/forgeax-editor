# ForgeaX Studio — forgeax-editor

[English](./README.md) · [简体中文](./README.zh-CN.md) · [↑ studio](https://github.com/ForgeaX-Games/forgeax-studio)

> **可视化场景编辑器 —— 对同一个场景做「所见即所得」的直接编辑与真实引擎游玩,以严格分层的五包 monorepo 构建。**

`forgeax-editor` 是 Studio 内嵌的「所编即所玩」场景编辑器。它不是一个假视口:**Edit** 模式在真实
的 `SceneDocument` 之上提供层级、检查器、资产浏览、材质图与时间轴;**Play** 模式则在同一个场景上
启动*真正的*引擎(物理、FPS 捕获、诊断)。因为两者读同一份磁盘场景,你编辑的就是你游玩的。

## 它为何重要

- **Edit 与 Play,同一场景,绝不漂移。** 两种模式作用于同一份落盘场景,因此没有「导出去测」的往返
  ——切到 Play 你就在运行中的游戏里,切回来你的编辑原样还在。
- **Play 是隔离的 thick host。** Play 模式作为独立运行时运行,**只通过一套带类型的 iframe 消息
  协议**与编辑器 core 通信。运行中游戏的崩溃或失控帧不会拖垮编辑器——边界是协议,而非共享内存。
- **架构是被强制的,而非口号。** 各包构成严格的依赖 DAG——`editor-core ← editor-shared ←
  editor-panels ← edit-runtime`——`bun run lint:dep`(dependency-cruiser)在任何 import 违反它时
  **让构建失败**。可依赖的分层。
- **真实的文档模型。** `editor-core` 携带 `SceneDocument`、`EditorBus`、undo/redo、schema、
  sync-channel、动画与材质图——一个严肃编辑器所需的底座,而非一堆零散状态。
- **它内嵌真实引擎。** Edit 模式为视口启动引擎;Play 模式把它作为完整 host 启动——因此材质、光照、
  物理在编辑器里的样子,和发布出去的游戏里完全一致。

## 五个包

| 包 | 职责 |
|:--|:--|
| `@forgeax/editor-core` | 核心逻辑——`SceneDocument`、`EditorBus`、undo/redo、schema、sync-channel、动画、材质图、资产、预设 |
| `@forgeax/editor-shared` | 跨层运行时——Zustand store、实体操作、右键菜单、dock 桥、panel-manifest SSOT |
| `@forgeax/editor-panels` | 8 个面板——层级 · 检查器 · 资产 · 历史 · 能力 · 材质 · 时间轴 · 材质图——外加面板组件注入 |
| `@forgeax/editor-edit-runtime` | Edit 模式入口——引擎启动 + 相机 + dock 外壳 + `EditorApp` |
| `@forgeax/editor-play-runtime` | Play 模式 thick host——FPS 捕获、物理门、pack-index、诊断浮层 |

五个入口(`.` / `./edit` / `./play` / `./panels` / `./protocol`)让使用方只取所需的那一层。

## 关键概念

`SceneDocument` + `EditorBus`(文档模型 + 事件总线)· undo/redo + sync-channel · 8 个面板 +
可停靠外壳 · disk-SSOT 的 Edit↔Play 同步 · Play 作为隔离的 iframe-协议 host · 被强制的
`core ← shared ← panels ← edit` DAG。

## 它如何融入 studio

Studio 在聊天驱动流程旁挂载编辑器以做直接操作的场景工作:Forge 能用代码写出一个场景,你能在编辑器
里可视化地打磨它——两者写入磁盘上的同一份场景,由同一台引擎渲染。切到 Play 即真实运行。

## 运行(独立)

首次克隆必须拉取 submodule——编辑器把引擎与 interface vendored 在 `packages/` 下。

```bash
bun install
bun dev            # 编辑器(Edit + Play)
bun run lint:dep   # 校验分层 DAG 是否成立
bun run test:e2e   # Playwright 端到端
```

---

本仓是 **ForgeaX Studio** 的一个子模块,隶属
[`ForgeaX-Games/forgeax-studio`](https://github.com/ForgeaX-Games/forgeax-studio) ——
用 `--recurse-submodules` 克隆超级仓即可运行完整 studio。许可:Apache-2.0。
