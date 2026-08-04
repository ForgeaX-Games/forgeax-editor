# forgeax-contracts

forgeax 的**中立契约闭包**——一个 git 仓内放两个独立被消费的包:

| 包 | 作用 |
|---|---|
| `@forgeax/types` | 跨端共享的 zod schema + TS 契约(`forgeax-extension.json` / agent / skill / tool / host-sdk / observability 的 SSOT) |
| `@forgeax/agent-runtime` | `core`(内核)↔`cli`(编排)之间的**中立 DIP 注册表**(core 注册进它,cli 从它消费)。**绝不能并进 cli**——否则 core 反向依赖 cli,层级反转、废掉 DIP。 |

## 为什么合在一个仓

两个包同节奏、同纯度(纯叶/纯契约,无业务、无 build),`agent-runtime → types` 是仓内闭环依赖。合一个仓让「契约层」可被任意 forgeax 项目作为单个子模块整体拉取。

## 形态

- **全裸 TS,无 build**:消费方若是 bun,直接吃裸 TS。
- 仓内是一个 bun workspace(`workspaces: ["types", "agent-runtime"]`),`agent-runtime` 的 `@forgeax/types: workspace:*` 在仓内自解析,可独立 `bun install && bun run typecheck`。
- 作为上游超级仓的子模块挂载时,两个包仍是上游 bun workspace 的成员,消费者 import 路径(`@forgeax/types` / `@forgeax/agent-runtime`)不变。

## 独立验证

```bash
bun install
bun run typecheck   # 两个包各自 tsc --noEmit
bun run test
```
