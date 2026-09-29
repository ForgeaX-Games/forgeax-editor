# Editor standalone 应用

这是保留在 Editor 仓库中的私有应用，使用可复用的 Editor 实现和已发布的
Interface 应用壳。它不发布 npm 包，不进入 `@forgeax/editor` 的 tarball，
也不是根 Editor 包的依赖。

| 依赖 | 职责 |
|:--|:--|
| `@forgeax/editor`（`file:../..`） | 当前仓库的公开 facade |
| Editor workspace 包 | Editor 实现与 UI |
| `@forgeax/interface` | 精确版本的已发布应用壳 |

初始化子模块后，在仓库根目录执行 `bun install`。根 Bun 配置使用 hoisted
链接，使 `file:../..` 指向当前根包源码，而不是复制另一份运行时。这是同仓库
workspace 应用，不是需要另行克隆的仓库；无需注册 `bun link` 或发布 standalone。

| 命令（在当前目录执行） | 作用 |
|:--|:--|
| `bun run dev` | 启动现有 standalone 开发服务组 |
| `bun run dev:host` | 只启动应用壳，需要已运行的 edit runtime |
| `bun run build` | 构建到应用内已忽略的 `dist/` 目录 |
| `bun test ./__tests__ --path-ignore-patterns=**/repro-console.test.mjs` | 执行应用单测和已发布依赖的身份一致性测试 |

根目录的 `bun run dev:standalone`、`bun run dev` 和 `bun fx start` 保持可用。
共享 Vite、开发服务和 Playwright 配置仍由仓库管理。相对的 `FORGEAX_GAME_DIR`
以调用目录为基准；切换根目录与应用目录执行命令时，建议使用绝对游戏路径。

`repro-console.test.mjs` 是需要已启动服务的独立诊断，不属于单测。浏览器 E2E
测试仍在 `e2e/__tests__/`，通过根目录的 Playwright 命令执行。原有根目录
`bun run typecheck` 和 `bun fx ci` 门禁不变；本次包边界调整不新增整个应用的
TypeScript 检查门禁。
