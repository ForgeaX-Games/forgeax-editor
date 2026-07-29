# forgeax-platform-io

> **一次 mutation 全成或全不成。** `@forgeax/platform-io` 为一个逻辑 root 提供业务无关的 opaque bytes、revision、trash、observer 和结构化错误事实。

## 最小成功流程

```ts
import { openResourceRoot, type ResourceStore } from '@forgeax/platform-io';

declare const store: ResourceStore;
const opened = await openResourceRoot({ rootId: 'game-main', store });
if (!opened.ok) throw opened.error;

const before = await opened.value.readSnapshot();
if (!before.ok) throw before.error;

const committed = await opened.value.commit({
  identity: 'save-001',
  expectedRevision: before.value.revision,
  changes: [
    { kind: 'put', resourceId: 'scenes/main.pack', bytes: Uint8Array.from([1, 2]) },
  ],
});
if (!committed.ok) {
  // Branch on committed.error.code and follow committed.error.hint.
  throw committed.error;
}
```

先从包公共入口发现 `RESOURCE_SUBSTRATE_CAPABILITY_INDEX`，再按
[`docs/resource-substrate.md`](docs/resource-substrate.md) 的稳定标题读取详细行为。

后端 **L1 平台 IO 基建**: files / assets / projects / fs / logs / prefs / version / changelog / boot-splash 等纯 IO router + `safe-path` / `io` / `asset-root` 工具。

## L1 铁律:零上行依赖

`@forgeax/platform-io` 是最通用的底座——**禁止 import 任何 `@forgeax/*` 兄弟包**,只能依赖第三方(hono)与 node 内建。这条由 `.dependency-cruiser.cjs` 锁死。谁都能依赖它,它依赖谁都不行。被 cli(后 L2)/ server(后 L3)/ editor(前 L2)直接复用。

> 历史:此前物理上嵌在 `forgeax-kernel` 子模块的 `platform-io/` 子目录里(容器名 `kernel` 与真内核 `@forgeax/cli` 打架)。现已提为独立仓,诚实命名。

## 形态

- **全裸 TS，无 build**: bun 直跑源码。
- 仓根即 `@forgeax/platform-io` 包(flat repo)。

## 独立验证

```bash
bun install
bun run typecheck
bun run test
bun run lint:boundaries
```
