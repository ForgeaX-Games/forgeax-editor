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
import { createSession, fetchSessionList } from './forgeax-bridge';
import { useAppStore, tabLabel, type AppMode } from '../store';
import { setActiveWorkspace } from './workspaces';
import { useHealthStore } from '../components/StatusBar/healthStore';
import { getBrowserConsole, clearBrowserConsole } from '../components/StatusBar/healthBridge';
import { listBusPlugins, pickLang } from './bus-api';

let registered = false;

/** bootUiBridge 调用一次(幂等)。 */
export function registerBuiltinActions(): void {
  if (registered) return;
  registered = true;
  const st = () => useAppStore.getState();

  // ── 视图 / 布局(纯 UI)──────────────────────────────────────────────────
  registerAction({
    id: 'app.set_mode',
    title: '切换主模式',
    description:
      "Switch the app's main workspace: 'edit' (game editing) or 'workbench' (AI · plugins & tools). Same as clicking the Edit / AI tabs.",
    // 'bus' 已退役(bus 清单 2026-05-17 移进 Settings 浮层的 Plugins 段,mode==='bus' 不再渲染);
    // 只留两个真能切换的工作区,避免选了没反应。需要 bus 请用 overlay.open{id:'settings'}。
    schema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['edit', 'workbench'] } },
      required: ['mode'],
    },
    capability: 'write',
    firstClass: true, // P1-9:高频 action 派生一等 ToolSpec(ui_act_*)
    surface: 'ui',
    run: (args) => {
      const mode = args.mode as AppMode; // 'edit' | 'workbench'
      // 当前布局按活动工作区渲染;只 setMode 是历史遗留、DockShell 不认(与 workbench.open 同病根)。
      setActiveWorkspace(mode);
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
      // 当前布局按「活动工作区」渲染(Edit / AI 标签,AI 的 workspace id 即 'workbench');
      // 只 setMode 是历史遗留、DockShell 不认——必须切活动工作区,和标签的 switchTo 一致。
      setActiveWorkspace('workbench');
      st().openWorkbench({ ...(typeof args.tab === 'string' ? { tab: args.tab } : {}) });
      return {
        status: 'completed',
        stateDigest: { mode: st().mode, activeWorkspace: 'workbench', workbenchTab: st().workbenchTab },
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
      const { items } = await listBusPlugins('workbench');
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
    schema: { type: 'object', properties: { pluginId: { type: 'string' } }, required: ['pluginId'] },
    capability: 'write',
    firstClass: true,
    surface: 'ui',
    // 命令面板把 pluginId 变成「现有插件」下拉,免瞎填。
    choices: {
      pluginId: async () => (await listBusPlugins('workbench')).items.filter((p) => !p.workbench?.hidden).map((p) => p.id),
    },
    run: (args) => {
      const pluginId = args.pluginId as string;
      setActiveWorkspace('workbench');
      st().openWorkbench({ expandedPluginId: pluginId });
      return { status: 'completed', stateDigest: { activeWorkspace: 'workbench', expandedPluginId: pluginId } };
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
      const { sid } = await createSession(
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
      const rows = await fetchSessionList(st().pinnedSlug ?? undefined);
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
