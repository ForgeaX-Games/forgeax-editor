# `@forgeax/editor-play-runtime`

> forgeax editor Play 模式厚 host — FPS 鼠标捕获、physics gate、按游戏 pack-index、加载遮罩、诊断遮罩、VAG_CONSOLE 桥接。

## 功能

- **FPS 鼠标捕获**：基于 `forge.json` 的 `pointerLock` / `input` 字段 opt-in；通过 `window.parent.postMessage({ type: 'fx-pointer-capture' })` 与 Tauri 壳通信
- **Physics gate**：基于 `forge.json` 的 `physics` 字段 opt-in（`rapier-3d` / `rapier-2d`）
- **按游戏 pack-index**：每游戏独立的 `pack-index/<slug>.json`
- **加载遮罩**：冷启动渐变遮罩 + 首帧渲染后淡出
- **诊断遮罩**：WebGPU 不可用时的不安全远程诊断 + RhiError 结构化错误展示
- **VAG_CONSOLE 桥接**：完整的 console 劫持 + Error.detail 展示 + Vite HMR build error forwarding
- **Pause/Play/Reload**：`VAG_PREVIEW_PAUSE` / `VAG_PREVIEW_PLAY` / `VAG_PREVIEW_RELOAD` postMessage 协议

## 导入示例

```ts
import type { GameContext } from '@forgeax/editor-play-runtime';
```

> [!NOTE]
> Play runtime 主要为 iframe 内的独立 vite 应用（端口 15173），非典型 node_modules import 场景。AppKit 通过 URL `http://127.0.0.1:15173/preview/?game=<slug>` 嵌入 iframe。

## exports 子入口

| 入口 | 说明 |
|:--|:--|
| `.` | `GameContext` 类型 |
| `./package.json` | 包元信息 |

## troubleshooting

| 症状 | 原因 | 解决 |
|:--|:--|:--|
| `/preview/?game=<slug>` 白屏 | WebGPU 不可用或 createApp 失败 | 浏览器打开 DevTools → 查看诊断遮罩的详细错误信息（code/expected/hint） |
| HMR 不生效 | 文件事件未传到 engine-src 的 vite watcher | 确认 `usePolling: true` 且 `run.sh` 的 symlink 有效 |
| play-runtime 端口 15173 被占用 | 另一个 engine vite 实例未停止 | `bash stop.sh` 停止所有服务后重试 |