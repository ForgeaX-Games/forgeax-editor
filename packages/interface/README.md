# forgeax-interface

forgeax 前端工程（Studio 三栏 UI）。

## 技术栈

- **Bun** runtime · **Vite 6** dev server · **React 19** · **TypeScript**
- **Zustand** 状态管理
- **lucide-react** 图标
- 配色对齐 VAG 海外版 Design System（主色荧光绿 `#D4FF48`）

## 启动

```bash
cd ForgeaX-Games/forgeax-interface
bun install
bun dev   # http://localhost:18920
```

## 结构

```
src/
├── main.tsx                    # 入口
├── App.tsx                     # 三栏 shell
├── store.ts                    # Zustand: mode / activeSession / activeAgent
├── styles/
│   ├── tokens.css              # VAG 配色 token
│   └── global.css              # 重置 + 滚动条
├── components/
│   ├── TopBar/                 # 顶部 + Preview/Workbench mode switcher
│   ├── Sidebar/                # 左栏 — AgentSession + Workbench工具 + 长期记忆
│   ├── MainArea/               # 中栏 — Preview iframe / Workbench 编辑器
│   └── ChatPanel/              # 右栏 — FORGE 卡 + Thought process + Composer
└── assets/icons/               # 24 个图标（agent-icon.png + status-* + chevron-*）
```

## 模式切换

顶部胶囊：**Preview** (`⌘1`) / **Workbench** (`⌘2`) / **Bus** (`⌘3`) — 切换中央 MainArea 内容；左/右栏不变。

---

## 2026-05-15 → 16 Bus surface 网

v3 prompt daemon ~40 commit 后 UI 现状（详见 `forgeax-dev-diary/2026-05-16/UI-FRAMEWORK-PROPOSAL.md` §1 审计）：

### Surface 网（5 处 deep-link 互通）

- **TopBar**：3 mode-tab 各带 count chip（Preview 3 ws-client / Workbench 11 wb / Bus 19 plugin）· 同色对称
- **Sidebar**：上半 WORKBENCH 行 11 wb-* 图标（icon 读自 manifest）+ 单击 placeholder 卡（zh/en 描述 / manifest 路径 / 跳 Bus 详情按钮）· 下半 AGENTS 列 7 agent 卡片（role-tribe 6 色 dot · cc-coder `bus →` 可点 deep-link）· 底部 BUS KINDS 6 chip 横排（wb 11 / ag 1 / cli 4 / mb 1 / sk 1 / tl 1 click → BusAdmin kind filter）· header `BusHealthChip` 19 plugin 数字 + 健康灯
- **MainArea**：
  - Preview mode → 游戏 iframe（vite proxy 到 engine 15173）+ TEAM role-tribe dot strip
  - Workbench mode → 11 wb-* plugin gallery（icon + 名 + 描述 + chip）
  - Bus mode → BusAdminPanel（kind chip filter + search + 19 行表 · 行展开渲染 provides[] 4 色块 cliProvider/skills/tools/events + 反向 deep-link 回 Sidebar / wb tab）
- **ChatPanel**：empty state BUS HOST 卡片（19 plugin + 6 kind chip + FORGE 范例 prompt）· TabStrip 加 bus chip · AgentSwitcher 7 marketplace placeholder avatar + role-tribe outer ring · Composer cli dropdown 行带 bus desc + bus → deep-link · 顶部 model-binding teal VIA chip strip · agent → bus mini bar
- **Dashboard**（overlay）：Overview/Analytics/Runs/Threads 4 子页全 cli-provider Bus 视图收口（双 strip 双维度过滤 provider × status + 表格行 role dot + capability matrix）

### 当前架构现状

- 26 .tsx · 10 .css · 4977 CSS 行 · 51 store action · 263 hook 调用 · 1 个 Zustand store（1460 行单文件）
- **零依赖**：无 Radix / Headless UI / shadcn / MUI / Tailwind · 无 react-router · 无 dnd-kit / framer-motion
- **Token 体系**：`src/styles/tokens.css` + `primitive.css`（Figma `*.tokens.json`）· 526+ 处 `var(--*)` · 6 kind 配色家族（lime/violet/blue/teal/amber/orange）
- **预览布局合并**：`src/styles/forgeax-preview/` 仅布局/结构 · 颜色/图标服从 token + lucide（见 `forgeax-preview/DESIGN-SYSTEM.md`）
- **可拖拽**：自写 `<ResizeHandle>` 80 行 pointer-capture · `useLocalSize` localStorage 持久化

### 已知架构债（待 P5-P9）

1. **Overlay 原语 0/6** — 6 处 `alert()`/`confirm()` 在生产代码 · 4 个 dropdown 各自手 roll click-outside · 0 处 createPortal · 缺 Modal/Popover/Toast/Tooltip/CommandPalette
2. **plugin runtime 不存在** — 11 wb-* tab body 全是 `<BusPluginPlaceholder>` 静态卡 · 没有 iframe / panel.esm.js 加载
3. **3 栏布局硬编码** — 无 dock / collapse / 第二行 split
4. **无 cmd-k / 全局快捷键** — 只有 Cmd+S + Esc
5. **store 1460 行单文件** · sendMessage ~400 行 · UI state + fetch + SSE 全在一起
6. **dark-only 主题** — 0 处 `[data-theme]` / `prefers-color-scheme`

### 路线图

- **P5** UI Primitives 6 件套 self-rolled ~600 LOC（Modal/Popover/DropdownMenu/Tooltip/Toast/CommandPalette）
- **P6** Command Registry + Cmd-K（~470 LOC）
- **P7** Theme + LayoutService（5 part dock）
- **P8** Plugin Runtime（`<WorkbenchIframeHost>` + panel.esm.js + character workbench MVP 验证端到端）
- **P9** 双模态 UI（host + plugin 同构 surface · AG-UI 扩展 · 玩家与 AI 共操作）

### 相关文档

- `forgeax-dev-diary/2026-05-15/00-GOALS.md` §五 11 类 workbench / §七 三合一
- `forgeax-dev-diary/2026-05-15/modules/10-workbench-spec.md`（iframe + mount(ctx) 协议）
- `forgeax-dev-diary/2026-05-16/UI-FRAMEWORK-PROPOSAL.md`（架构审计 + P5-P8 颗粒图）
- `forgeax-dev-diary/2026-05-16/DUAL-MODALITY-UI.md`（host = plugin 同构 · UISurface 抽象）
- `forgeax-dev-diary/2026-05-16/STRATEGY-PLAN-v3.md`（OSS / Desktop / Cloud 三产品定位）
- `~/.forgeax/auto-dev-progress.md`（daemon 颗粒账本）

---

## 2026-05-17 update · Bus 第一公民 + Workspaces + Settings 浮层

5 路 surface 全部接通 Bus(每个 chip / row / pill 都能 deep-link 反查 plugin):

- **Sidebar** — bus health 灯 + BUS KINDS footer(键盘 ↑↓⏎ 可用 · phase3.50)
- **TopBar** — bus / skill / tool / agent LED count chip(role-tribe 着色 · P4.20-P4.22)+ ProjectSwitcher(任意目录开 workspace)
- **Composer** — cli bus pill + `@` button → agent mention popover + `/` slash → skills
- **Dashboard** — Overview Bus card · ThreadsList/RunsList provider role dot + distribution strip · Agents Hub pane
- **ChatPanel** — empty-state Bus readout · `CpProvPulse` cli-provider health pill · SKILL gold LED pill

**Settings 浮层** 取代 Bus mode tab(phase4 后期)。sections registry:Plugins / Keys / Models / CLI / Workspace / Account / About。Keys 段直接编辑 `SAFE_ENV_KEYS`。

**Session-Thread-Agents 三合一** —— AgentsPanel / AgentSwitcher 现在是本-session-scoped 视图。SessionSwitcher 重写。ChatPanel 刷新按 `providerOverride` 分流(forgeax → ledger · 其他 → `.forgeax/runs/` AG-UI)。

**布局** —— resizable sidebar / chat / wb-bottom · ContextMenu primitive · Composer refactor(message-parts/ 抽出)。

完整数据 + 截图:[`../../forgeax-dev-diary/2026-05-18/SUMMARY.html`](../../forgeax-dev-diary/2026-05-18/SUMMARY.html)
