/** builtin-actions —— 首批高频 action 登记(产品 AI 化 P0,方案 §6)。
 *
 *  内容层:这里是**产品专属内容**(interface 知道自己有哪些功能),机制归 action-registry。
 *  每条 action 就是包一层 zustand store action / forgeax-bridge REST——按钮与 AI 走同一条
 *  路(Derive 不 Duplicate)。capability 如实声明:它是编排层 trust-gate 的权限输入,
 *  delete 类(session.close)会弹用户确认卡,这是有意的。
 *
 *  surface 口径(方案 §5):纯视图操作 'ui';背后是 server REST 的标 'both'(headless
 *  等价路径 P1 接线,声明先行,UI run() 已经就是调同一 HTTP API,server 是行为 SSOT)。
 */
import { registerAction, registerStateSlice } from './action-registry';
import { getSessionClient } from '../store-parts/session-client';
import { useShellStore, tabLabel, type AppMode } from '../store';
import { setActiveWorkbench } from './workbenches';
import { useHealthStore } from '../components/StatusBar/healthStore';
import { getBrowserConsole, clearBrowserConsole } from '../components/StatusBar/healthBridge';
import { listExtensions, pickLang } from './extension-api';

let registered = false;

/** bootUiBridge 调用一次(幂等)。 */
export function registerBuiltinActions(): void {
  if (registered) return;
  registered = true;
  const st = () => useShellStore.getState();

  // ── 视图 / 布局(纯 UI)──────────────────────────────────────────────────
  registerAction({
    id: 'app.set_mode',
    title: '切换主模式',
    description:
      "Switch the app's main workspace: 'scene' (game editing) or 'ai' (AI · plugins & tools). Same as clicking the Scene / AI tabs.",
    // 'bus' 已退役(bus 清单 2026-05-17 移进 Settings 浮层的 Plugins 段,mode==='bus' 不再渲染);
    // 只留两个真能切换的工作区,避免选了没反应。需要 bus 请用 overlay.open{id:'settings'}。
    schema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['scene', 'ai'] } },
      required: ['mode'],
    },
    capability: 'write',
    firstClass: true, // P1-9:高频 action 派生一等 ToolSpec(ui_act_*)
    surface: 'ui',
    run: (args) => {
      const mode = args.mode as AppMode; // 'scene' | 'ai'
      // 当前布局按活动工作区渲染;只 setMode 是历史遗留、DockShell 不认(与 workbench.open 同病根)。
      setActiveWorkbench(mode);
      st().setMode(mode);
      return { status: 'completed', stateDigest: { mode: st().mode, activeWorkspace: mode } };
    },
  });

  registerAction({
    id: 'panel.toggle_sidebar',
    title: '折叠/展开侧栏',
    description: 'Toggle the left sidebar collapsed state.',
    capability: 'write',
    surface: 'ui',
    run: () => {
      st().toggleSidebar();
      return { status: 'completed', stateDigest: { sidebarCollapsed: st().sidebarCollapsed } };
    },
  });

  registerAction({
    id: 'panel.toggle_chatpanel',
    title: '折叠/展开聊天面板',
    description: 'Toggle the chat panel collapsed state.',
    capability: 'write',
    surface: 'ui',
    run: () => {
      st().toggleChatpanel();
      return { status: 'completed', stateDigest: { chatpanelCollapsed: st().chatpanelCollapsed } };
    },
  });

  registerAction({
    id: 'app.set_fullscreen',
    title: '沉浸模式',
    description: 'Enter or exit fullscreen (immersive) mode which hides all chrome around the main area.',
    schema: { type: 'object', properties: { value: { type: 'boolean' } }, required: ['value'] },
    capability: 'write',
    surface: 'ui',
    run: (args) => {
      st().setFullscreen(args.value as boolean);
      return { status: 'completed', stateDigest: { fullscreen: st().fullscreen } };
    },
  });

  registerAction({
    id: 'workbench.open',
    title: '打开 Workbench',
    description: "Open the workbench surface, optionally at a specific tab (e.g. 'plugins').",
    schema: { type: 'object', properties: { tab: { type: 'string' } } },
    capability: 'write',
    firstClass: true, // P1-9:高频 action 派生一等 ToolSpec(ui_act_*)
    surface: 'ui',
    run: (args) => {
      // 当前布局按「活动工作区」渲染(Edit / AI 标签,AI 的 workbench id 即 'ai');
      // 只 setMode 是历史遗留、DockShell 不认——必须切活动工作区,和标签的 switchTo 一致。
      setActiveWorkbench('ai');
      st().openWorkbench({ ...(typeof args.tab === 'string' ? { tab: args.tab } : {}) });
      return {
        status: 'completed',
        stateDigest: { mode: st().mode, activeWorkspace: 'ai', workbenchTab: st().workbenchTab },
      };
    },
  });

  // 插件桥(方案 §10 标注的「用户最在意、唯一还缺」的机制件):把 workbench 插件登记成
  // 可被模型发现/打开的 action —— 之前模型对插件无感知、只能 glob+read_file 源码猜用法。
  //  - workbench.list_plugins:列出插件 id/名称/说明,模型据此告诉用户"有哪些工具、干嘛的"。
  //  - workbench.open_plugin:切到工作台并展开指定插件(第一步「打开插件」的可执行动作)。
  // 「插件内部再怎么用」需插件各自登记自身 action(更深一层桥,后续做);当前先补发现+打开。
  registerAction({
    id: 'workbench.list_plugins',
    title: '列出工作台插件',
    description:
      'List installed workbench plugins (id, name, description). Use this to tell the user what workbench tools exist and what each does, then guide them with workbench.open_plugin. Returns { count, plugins:[{id,name,description}] }.',
    capability: 'read',
    firstClass: true,
    surface: 'ui',
    run: async () => {
      const { items } = await listExtensions('workbench');
      const plugins = items
        .filter((p) => !p.workbench?.hidden)
        .map((p) => ({
          id: p.id,
          name: pickLang(p.displayName, 'zh', p.id),
          description: p.description ? pickLang(p.description, 'zh', '') : '',
        }));
      return { status: 'completed', stateDigest: { count: plugins.length, plugins } };
    },
  });

  registerAction({
    id: 'workbench.open_plugin',
    title: '打开工作台插件',
    description:
      "Open the workbench and expand a specific plugin by id — the concrete 'open this plugin' step. It switches to the workbench (AI) workspace, then expands that plugin's panel. Discover valid ids and what each does via workbench.list_plugins.",
    schema: { type: 'object', properties: { extensionId: { type: 'string' } }, required: ['extensionId'] },
    capability: 'write',
    firstClass: true,
    surface: 'ui',
    // 命令面板把 extensionId 变成「现有插件」下拉,免瞎填。
    choices: {
      extensionId: async () => (await listExtensions('workbench')).items.filter((p) => !p.workbench?.hidden).map((p) => p.id),
    },
    run: (args) => {
      const extensionId = args.extensionId as string;
      setActiveWorkbench('ai');
      st().openWorkbench({ expandedExtensionId: extensionId });
      return { status: 'completed', stateDigest: { activeWorkspace: 'ai', expandedExtensionId: extensionId } };
    },
  });

  // 角色桥(插件桥的「角色版」:人和 AI 同一条路造/用/看角色)。role.create 是**唯一**创建
  // 路径 —— AI 经 ui_act_role_create / ui_invoke 调,人经 ⌘K / 按钮 pill 调;背后是 server
  // 执行器 team:create_role(对 AI 隐藏),经 /api/tools/call(caller:user)落 agent-pack 到
  // L1/L2 插件层、reloadPlugins,新角色 ~5s 内自动进名单(roster 轮询 +1)。治理靠 trust-gate
  // 的 delegate 闸(capability 如实声明)。role.list 让 AI 能告诉用户「有哪些角色」并防重名;
  // role.open 打开角色页 / 把某角色绑到当前会话展示其详情。
  registerAction({
    id: 'role.create',
    title: '创建新角色',
    description:
      'Mint a NEW teammate/agent role when no existing role in the roster fits. Args: id (single segment [a-zA-Z0-9_-]) + persona (markdown: who they are / what they are good at / when to delegate to them / what they produce) + optional displayName / role / avatar / color / scope("global"|"project") / tools(host-tool allow globs). The new role persists and joins the roster (delegate_to_subagent can then dispatch it). Duplicate ids are rejected, never overwritten. Discover existing roles first via role.list.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '单段 [a-zA-Z0-9_-];如 "level-designer"' },
        persona: { type: 'string', description: '角色 markdown:是谁 / 擅长什么 / 何时被派 / 产出什么' },
        displayName: {
          type: 'object',
          properties: { zh: { type: 'string' }, en: { type: 'string' } },
        },
        role: { type: 'string', description: "定位,如 'pillar' / 'artist' / 'peer'" },
        avatar: { type: 'string', description: 'emoji / 单字符' },
        color: { type: 'string', description: '#hex' },
        scope: { type: 'string', enum: ['global', 'project'] },
        tools: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'persona'],
    },
    capability: 'delegate',
    firstClass: true,
    surface: 'both',
    timeoutMs: 15000,
    run: async (args) => {
      const r = await fetch('/api/tools/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolId: 'team:create_role', caller: { kind: 'user' }, args }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        result?: { id?: string; scope?: string };
      };
      if (!r.ok || data.ok === false) {
        return { status: 'rejected', reason: data.error ?? `create role failed (HTTP ${r.status})` };
      }
      const res = data.result ?? {};
      return { status: 'completed', stateDigest: { id: res.id ?? args.id, scope: res.scope } };
    },
  });

  registerAction({
    id: 'role.list',
    title: '列出角色',
    description:
      'List all currently dispatchable roles (plugin agents + built-ins). Use this to tell the user which roles exist / check for duplicates before role.create. Returns { count, roles:[{id,role,displayName,source}] }.',
    capability: 'read',
    firstClass: true,
    surface: 'both',
    run: async () => {
      const r = await fetch('/api/tools/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolId: 'team:list_roles', caller: { kind: 'user' }, args: {} }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        result?: { count?: number; roles?: unknown[] };
      };
      if (!r.ok || data.ok === false) {
        return { status: 'rejected', reason: data.error ?? `list roles failed (HTTP ${r.status})` };
      }
      const res = data.result ?? {};
      return { status: 'completed', stateDigest: { count: res.count ?? 0, roles: res.roles ?? [] } };
    },
  });

  registerAction({
    id: 'role.open',
    title: '打开角色页',
    description:
      "Open the roles/team surface. With no args it switches to the AI workspace (where the roster lives). With { id } it also binds that role to the current chat session so its persona detail is shown. Use this to show the user the team or a specific teammate.",
    schema: { type: 'object', properties: { id: { type: 'string' } } },
    capability: 'read',
    firstClass: true,
    surface: 'ui',
    run: (args) => {
      const id = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : '';
      setActiveWorkbench('ai');
      st().openWorkbench({});
      if (id) {
        const sid = st().activeSid;
        if (sid) st().setTabAgent(sid, id); // 绑角色到当前会话 → 聊天区展示其 persona 详情条
        return { status: 'completed', stateDigest: { opened: id, activeWorkspace: 'ai' } };
      }
      return { status: 'completed', stateDigest: { activeWorkspace: 'ai' } };
    },
  });

  registerAction({
    id: 'overlay.open',
    title: '打开浮层',
    description: "Open an overlay by id (e.g. 'settings'). Optional param selects a section inside it.",
    schema: {
      type: 'object',
      properties: { id: { type: 'string' }, param: { type: 'string' } },
      required: ['id'],
    },
    capability: 'write',
    surface: 'ui',
    run: (args) => {
      st().openOverlay(args.id as string, typeof args.param === 'string' ? args.param : undefined);
      return { status: 'completed' };
    },
  });

  registerAction({
    id: 'overlay.close',
    title: '关闭浮层',
    description: 'Close the currently open overlay, if any.',
    capability: 'write',
    surface: 'ui',
    run: () => {
      st().closeOverlay();
      return { status: 'completed' };
    },
  });

  // ── 日志类(瞬态,清空不算删除用户数据)────────────────────────────────────
  registerAction({
    id: 'console.clear',
    title: '清空控制台',
    description:
      "Clear a collected console buffer. source:'browser' (default) clears the studio-shell browser console buffer PLUS the cross-tier health entries (fatal region banners are preserved). source:'game' clears the in-app game/editor console (store.consoleLog). Neither touches the raw browser DevTools buffer.",
    schema: { type: 'object', properties: { source: { type: 'string', enum: ['browser', 'game'] } } },
    capability: 'write',
    surface: 'ui',
    run: (args) => {
      const source = args.source === 'game' ? 'game' : 'browser';
      if (source === 'game') {
        const cleared = st().consoleLog.length;
        st().clearConsole();
        return { status: 'completed', stateDigest: { source, cleared } };
      }
      const cleared = getBrowserConsole().length + useHealthStore.getState().entries.length;
      clearBrowserConsole();
      useHealthStore.getState().clear(); // 只清 entries;fatal 横幅由 clearFatal 单独管,不受影响
      return { status: 'completed', stateDigest: { source, cleared } }; // 回报清了几条,避免「点了没反应」
    },
  });

  // AI 可读控制台(方案「让 AI 感知」的补全)。区分两个**不同**的东西:
  //  - source:'browser'(默认)→ 读 useHealthStore:studio 外壳已采集的**浏览器控制台/健康流**
  //    (shell 的 console.error/console.warn + window.onerror + unhandledrejection + iframe 转发的
  //     forgeax:health / VAG_CONSOLE 报错),跨端汇聚,也落盘 .forgeax/logs/info.jsonl。
  //    ⚠ 现采集只含 error/warn/health 级别,不含 shell 的 console.log/info(要全量需扩采集)。
  //  - source:'game' → 读 store.consoleLog:引擎/编辑器 iframe 的**游戏控制台**全量流。
  //  两者都不是浏览器 DevTools 的原始缓冲(网页读不到),'browser' 是产品自采集的最接近者。
  registerAction({
    id: 'console.read',
    title: '读取控制台',
    description:
      "Read the studio's collected console feed. source:'browser' (default) = the full studio-shell browser console (ALL levels: log/info/warn/error/debug, captured into a 500-entry ring buffer) merged with cross-tier iframe/health signals (window.onerror, unhandled rejections, forwarded play/edit/plugin/engine health). source:'game' = the in-app game/editor console stream. Params: source ('browser'|'game'), level (filter), limit (default 50, max 200). Returns { source, total, count, lines } in the result. This is the studio's own captured console (a web page cannot read the raw browser DevTools buffer directly).",
    schema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['browser', 'game'] },
        level: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    capability: 'read',
    firstClass: true, // 让模型直接看到这条读工具,免一次 snapshot 发现
    surface: 'ui',
    run: (args) => {
      const source = args.source === 'game' ? 'game' : 'browser';
      const level = typeof args.level === 'string' ? args.level : undefined;
      const limit = Math.min(typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 50, 200);
      if (source === 'game') {
        const all = st().consoleLog;
        const f = level ? all.filter((l) => l.level === level) : all;
        const lines = f.slice(-limit).map((l) => ({ level: l.level, text: l.text, ts: l.ts }));
        return { status: 'completed', stateDigest: { source, total: all.length, count: lines.length, lines } };
      }
      // browser: 外壳全量 console(browserConsole,所有 level)+ 跨端 iframe/health
      // (healthStore,去掉与外壳 console-error/warn 重复的),按 ts 合并取尾部。
      const shell = getBrowserConsole().map((e) => ({
        level: e.level as string,
        source: 'shell',
        code: undefined as string | undefined,
        text: e.text,
        ts: e.ts,
        ...(e.repeat ? { repeat: e.repeat } : {}),
      }));
      const health = useHealthStore
        .getState()
        .entries.filter((e) => !(e.source === 'shell' && (e.code === 'console-error' || e.code === 'console-warn')))
        .map((e) => ({ level: e.level as string, source: e.source, code: e.code, text: e.message, ts: e.ts }));
      let merged = [...shell, ...health].sort((a, b) => a.ts - b.ts);
      if (level) merged = merged.filter((e) => e.level === level);
      const lines = merged.slice(-limit);
      return { status: 'completed', stateDigest: { source, total: merged.length, count: lines.length, lines } };
    },
  });

  registerAction({
    id: 'network.clear',
    title: '清空网络日志',
    description: 'Clear the in-app network log panel (store.networkLog). NOT the browser DevTools network tab.',
    capability: 'write',
    surface: 'ui',
    run: () => {
      const cleared = st().networkLog.length;
      st().clearNetwork();
      return { status: 'completed', stateDigest: { cleared } };
    },
  });

  // ── 会话(背后是 server REST → surface 'both',server 是行为 SSOT)──────────
  registerAction({
    id: 'session.switch',
    title: '切换会话',
    description: 'Switch the active chat session to the given sid (see the session.tabs state slice for candidates).',
    schema: { type: 'object', properties: { sid: { type: 'string' } }, required: ['sid'] },
    capability: 'write',
    firstClass: true, // P1-9:高频 action 派生一等 ToolSpec(ui_act_*)
    surface: 'ui',
    timeoutMs: 15_000,
    run: async (args) => {
      await st().switchToSession(args.sid as string);
      return { status: 'completed', stateDigest: { activeSid: st().activeSid } };
    },
  });

  registerAction({
    id: 'session.create',
    title: '新建会话',
    description: 'Create a new chat session (optionally named) and switch to it.',
    schema: { type: 'object', properties: { displayName: { type: 'string' } } },
    capability: 'write',
    firstClass: true, // P1-9:高频 action 派生一等 ToolSpec(ui_act_*)
    surface: 'both',
    timeoutMs: 20_000,
    run: async (args) => {
      const { sid } = await getSessionClient().createSession(
        typeof args.displayName === 'string' ? { displayName: args.displayName } : undefined,
      );
      await st().refreshSessions();
      await st().switchToSession(sid);
      return { status: 'completed', stateDigest: { activeSid: sid } };
    },
  });

  registerAction({
    id: 'session.close',
    title: '关闭会话',
    description:
      'Close (delete) a chat session by sid. Destructive: the session and its history are removed from disk.',
    schema: { type: 'object', properties: { sid: { type: 'string' } }, required: ['sid'] },
    capability: 'delete', // 如实声明:编排层会弹确认卡
    firstClass: true, // P1-9:高频 action 派生一等 ToolSpec(ui_act_*)
    surface: 'both',
    timeoutMs: 15_000,
    run: async (args) => {
      await st().closeSession(args.sid as string);
      return { status: 'completed', stateDigest: { activeSid: st().activeSid } };
    },
  });

  registerAction({
    id: 'session.rename',
    title: '重命名会话',
    description: 'Rename a chat session tab.',
    schema: {
      type: 'object',
      properties: { sid: { type: 'string' }, displayName: { type: 'string' } },
      required: ['sid', 'displayName'],
    },
    capability: 'write',
    surface: 'both',
    run: (args) => {
      st().renameTab(args.sid as string, args.displayName as string);
      return { status: 'completed' };
    },
  });

  registerAction({
    id: 'sessions.refresh',
    title: '刷新会话列表',
    description: 'Re-fetch the session list from the server.',
    capability: 'read',
    surface: 'both',
    run: async () => {
      await st().refreshSessions();
      return { status: 'completed', stateDigest: { tabs: st().tabs.length } };
    },
  });

  registerAction({
    id: 'sessions.list',
    title: '列出会话',
    description: 'List chat sessions of the current game scope. Returns sid/displayName rows in stateDigest.',
    capability: 'read',
    surface: 'both',
    run: async () => {
      const rows = await getSessionClient().fetchSessionList(st().pinnedSlug ?? undefined);
      return {
        status: 'completed',
        stateDigest: rows.map((s) => ({ sid: s.sid, displayName: s.displayName ?? null })),
      };
    },
  });

  registerAction({
    id: 'game.switch',
    title: '切换游戏',
    description: 'Switch the pinned game (project) to the given slug. Sessions and preview re-scope to it.',
    schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    capability: 'write',
    firstClass: true, // P1-9:高频 action 派生一等 ToolSpec(ui_act_*)
    surface: 'both',
    timeoutMs: 20_000,
    // 命令面板把 slug 变成「现有游戏」下拉,避免瞎填触发 server 404。
    choices: {
      slug: async () => {
        const r = await fetch('/api/workbench/games');
        const j = (await r.json()) as { games?: { slug: string }[] };
        return (j.games ?? []).map((g) => g.slug);
      },
    },
    run: async (args) => {
      await st().switchGame(args.slug as string);
      return { status: 'completed', stateDigest: { pinnedSlug: st().pinnedSlug } };
    },
  });

  registerAction({
    id: 'game.create',
    title: '新建游戏',
    description:
      'Create a NEW game (project) from the template and give it its own dedicated chat session. Args: slug (required, 1-41 chars lowercase ASCII/digits/hyphens, must start with a letter/digit — e.g. "neon-runner") + optional name (display name) + optional brief (one line describing what game to make, recorded in FORGE.md for later). Fails with 409 if the slug already exists — use game.switch for existing games; list existing slugs to avoid collisions. NOTE: this does NOT switch the UI to the new game (switching mid-turn would break the active chat channel). Tell the user the game is ready and to open it from the top-bar game switcher; game.switch will land on its dedicated session.',
    schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '1-41 位小写字母/数字/连字符,首位字母或数字;如 "neon-runner"' },
        name: { type: 'string', description: '显示名(可选,缺省用 slug)' },
        brief: { type: 'string', description: '一句话说明要做什么游戏(可选,写进 FORGE.md)' },
      },
      required: ['slug'],
    },
    capability: 'write',
    firstClass: true,
    surface: 'both',
    timeoutMs: 20_000,
    run: async (args) => {
      const slug = String(args.slug ?? '').trim();
      const r = await fetch('/api/workbench/games', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug,
          ...(typeof args.name === 'string' ? { name: args.name } : {}),
          ...(typeof args.brief === 'string' ? { brief: args.brief } : {}),
        }),
      });
      const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; slug?: string };
      if (!r.ok || data.ok === false) {
        return { status: 'rejected', reason: data.error ?? `create game failed (HTTP ${r.status})` };
      }
      // 「一 session 一游戏」:给新游戏建**它自己**的一条 session(defaultDir=slug),但
      // **不切前端 WS/会话**。⚠️ 关键:本 action 常由 AI 在其会话内经 ui_invoke 触发;若
      // 当场 switchGame(切走 WS)会掐断 AI 自己的 ui_invoke 通道 → AI 反复重试 → UI 反复
      // 乱切 + 历史错乱(实测)。createSession 只 POST /api/sessions、不连 WS,所以安全:
      // 新游戏拥有独立会话,用户从顶栏 GameSwitcher 一键切过去(那是干净的非-AI-turn 切换,
      // switchGame 会落到这条已存在的会话)。
      let newSid: string | null = null;
      try {
        newSid = (await getSessionClient().createSession({ defaultDir: slug, autoStart: true })).sid;
      } catch { /* 建会话失败不影响游戏已创建;切换时 switchGame 会兜底建一条 */ }
      return {
        status: 'completed',
        stateDigest: { slug, session: newSid, hint: '新游戏已建好并配了独立会话;从顶栏游戏切换器切过去即可开始做' },
      };
    },
  });

  // ── 状态摘要片(评审 2.5:注册式 derive,禁手写台账)────────────────────────
  registerStateSlice('app.mode', () => st().mode);
  registerStateSlice('app.layout', () => ({
    fullscreen: st().fullscreen,
    sidebarCollapsed: st().sidebarCollapsed,
    chatpanelCollapsed: st().chatpanelCollapsed,
  }));
  registerStateSlice('game.pinned', () => st().pinnedSlug);
  registerStateSlice('session.active', () => st().activeSid);
  registerStateSlice('session.tabs', () =>
    st().tabs.slice(0, 20).map((t) => ({ sid: t.sid, label: tabLabel(t) })),
  );
}
