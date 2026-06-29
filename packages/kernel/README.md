# forgeax-kernel

forgeax 的**内核多包容器**(后端 L1):零 agent 依赖的纯基建包,被
`forgeax-studio`(superrepo)和独立的 `forgeax-editor` 仓**跨仓 pin 复用**。
作为 submodule 挂在各消费仓的 `packages/kernel/`。

## 包

| 包 | 角色 |
|---|---|
| [`platform-io`](./platform-io) | 后端 L1 平台 IO:files/assets/projects/fs/logs/prefs/version/changelog/boot-splash 等纯 IO router + safe-path/io。deps 仅 `hono`,零 `@forgeax/*` 上行。|

> 后续 `types` / `scene` / `host-sdk` 等纯契约包会陆续进同容器(多包一仓:仓合省 pin 税,包仍分开 → 浏览器 bundle 不被 `node:fs`/`hono` 污染)。

## 为什么单独成仓

判据(见 forgeax-studio `ideal-clean-architecture.md` §7.1):**已有独立仓现在就跨 repo 复用它**。`forgeax-editor` 要独立交付(clone 即跑),standalone 时需复用 `platform-io` 起最小后端——它必须能被 editor 跨仓 pin,故 `platform-io` 从 superrepo 内联目录抽成此仓。

## 用法

```bash
bun install          # 解析 platform-io workspace
bun run typecheck
bun run test
```

消费方把本仓作 submodule 挂在 `packages/kernel/`,根 workspaces 收 `packages/kernel/platform-io`,import 走包名 `@forgeax/platform-io`(不依赖物理路径)。
