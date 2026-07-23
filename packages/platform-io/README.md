# forgeax-platform-io

后端 **L1 平台 IO 基建**:files / assets / projects / fs / logs / prefs / version / changelog / boot-splash 等纯 IO router + `safe-path` / `io` / `asset-root` 工具。

## L1 铁律:零上行依赖

`@forgeax/platform-io` 是最通用的底座——**禁止 import 任何 `@forgeax/*` 兄弟包**,只能依赖第三方(hono)与 node 内建。这条由 `.dependency-cruiser.cjs` 锁死。谁都能依赖它,它依赖谁都不行。被 cli(后 L2)/ server(后 L3)/ editor(前 L2)直接复用。

> 历史:此前物理上嵌在 `forgeax-kernel` 子模块的 `platform-io/` 子目录里(容器名 `kernel` 与真内核 `@forgeax/cli` 打架)。现已提为独立仓,诚实命名。

## 形态

- **全裸 TS,无 build**:bun 直跑源码。
- 仓根即 `@forgeax/platform-io` 包(flat repo)。

## 独立验证

```bash
bun install
bun run typecheck
bun run test
bun run lint:boundaries
```
