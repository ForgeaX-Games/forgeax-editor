// packages/interface/src/core/extensions/builtin-commands.ts
//
// Ports `lib/builtin-actions.ts` to the command bus. The zustand store is
// still the state SSOT (until PR 3); the actions here are thin wrappers
// that (a) live on the command bus (so keyboard / palette / iframe all
// hit the same entry) and (b) still call `useShellStore` / clients under
// the hood.
//
// Static imports are used instead of the lazy `require(...)` pattern the
// spec suggested — the interface is ESM ("type": "module") and no cycle
// exists: this file is a leaf plugin, nothing else imports it. Direct
// static imports keep the concept count lower.

import type { AppExtension } from '../app-shell/types';
import { useShellStore } from '../../store';
import { setActiveWorkbench } from '../../lib/workbenches';
import { bumpDockResetEpoch } from '../../components/DockShell/dockResetEpoch';
import { isPanelVisible } from '../../components/DockShell/DockRegion';
import { isTauri } from '../../lib/platform/runtime';

const getState = () => useShellStore.getState();

export const builtinCommandsExtension: AppExtension = {
  id: 'builtin-commands',
  version: '1.0.0',
  requires: ['commands'],
  setup(ctx) {
    const { registerCommand } = ctx;
    const cleanups: Array<() => void> = [];

    cleanups.push(registerCommand({
      id: 'app.set_mode',
      title: '切换主模式 (scene / ai)',
      execute: (args) => {
        const mode = (args as { mode?: 'scene' | 'ai' })?.mode;
        if (mode !== 'scene' && mode !== 'ai') throw new Error('app.set_mode: mode must be scene | ai');
        setActiveWorkbench(mode);
        return { status: 'completed' as const, mode };
      },
    }));

    cleanups.push(registerCommand({
      id: 'app.panel.open',
      title: 'Open (or focus) a dock panel by id',
      execute: (args) => {
        const id = (args as { id?: string })?.id;
        if (!id) throw new Error('app.panel.open: missing { id }');
        ctx.bus.emit('panel:open', { id });
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(registerCommand({
      id: 'app.panel.focus',
      title: 'Focus an existing dock panel by id (no reopen)',
      execute: (args) => {
        const id = (args as { id?: string })?.id;
        if (!id) throw new Error('app.panel.focus: missing { id }');
        ctx.bus.emit('panel:focus', { id });
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(registerCommand({
      id: 'app.panel.close',
      title: 'Close a dock panel by id (no-op if not open)',
      execute: (args) => {
        const id = (args as { id?: string })?.id;
        if (!id) throw new Error('app.panel.close: missing { id }');
        ctx.bus.emit('panel:close', { id });
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(registerCommand({
      id: 'app.panel.toggle',
      title: 'Toggle a dock panel by id (open if hidden, close if visible)',
      execute: (args) => {
        const id = (args as { id?: string })?.id;
        if (!id) throw new Error('app.panel.toggle: missing { id }');
        // Visibility comes from DockRegion's module-level mirror (kept in sync
        // via onDidAddPanel/onDidRemovePanel). Command stays thin: it only picks
        // which existing event to emit; DockRegion owns the open/close logic.
        if (isPanelVisible(id)) ctx.bus.emit('panel:close', { id });
        else ctx.bus.emit('panel:open', { id });
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(registerCommand({
      id: 'app.open_url',
      title: 'Open an external http(s) URL in the OS default browser',
      execute: async (args) => {
        const url = (args as { url?: string })?.url;
        if (typeof url !== 'string' || !url) throw new Error('app.open_url: missing { url }');
        const trimmed = url.trim();
        if (!/^https?:\/\//i.test(trimmed)) {
          throw new Error(`app.open_url: only http(s) URLs are allowed, got: ${trimmed}`);
        }
        if (isTauri()) {
          // Prefer the plugin-shell opener so the URL goes to the OS default
          // browser, not the tauri webview. If the capability isn't granted the
          // call rejects — fall through to window.open in that case.
          try {
            const shell = await import('@tauri-apps/plugin-shell');
            await shell.open(trimmed);
            return { status: 'completed' as const };
          } catch { /* fall through */ }
        }
        try { window.open(trimmed, '_blank', 'noopener'); } catch { /* noop */ }
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(registerCommand({
      id: 'app.dock.reset',
      title: 'Reset dock layout',
      execute: () => {
        // Epoch first so DockRegions that are not yet subscribed / onReady can
        // still apply this reset exactly once when they become ready.
        bumpDockResetEpoch();
        ctx.bus.emit('dock:reset', {});
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(registerCommand({
      id: 'app.dock.layoutToggle',
      title: 'Open the dock layout menu',
      execute: (args) => {
        ctx.bus.emit('dock:layout-toggle', (args as { workbenchId?: string; rect?: { top: number; bottom: number; left: number; right: number } }) ?? {});
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(registerCommand({
      id: 'panel.toggle_sidebar',
      title: '折叠/展开侧栏',
      execute: () => { getState().toggleSidebar(); return { status: 'completed' as const }; },
    }));

    cleanups.push(registerCommand({
      id: 'panel.toggle_chatpanel',
      title: '折叠/展开聊天面板',
      execute: () => { getState().toggleChatpanel(); return { status: 'completed' as const }; },
    }));

    cleanups.push(registerCommand({
      id: 'app.set_fullscreen',
      title: '沉浸模式',
      execute: (args) => {
        const value = (args as { value?: boolean })?.value ?? false;
        getState().setFullscreen(value);
        return { status: 'completed' as const, value };
      },
    }));

    cleanups.push(registerCommand({
      id: 'workbench.open',
      title: '打开 Workbench',
      execute: (args) => {
        const tab = (args as { tab?: string })?.tab;
        setActiveWorkbench('ai');
        getState().openWorkbench(tab !== undefined ? { tab } : {});
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(registerCommand({
      id: 'overlay.open',
      title: '打开浮层',
      execute: (args) => {
        const p = args as { id?: string; param?: string } | undefined;
        if (!p?.id) throw new Error('overlay.open: missing { id }');
        getState().openOverlay(p.id, p.param);
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(registerCommand({
      id: 'overlay.close',
      title: '关闭浮层',
      execute: () => { getState().closeOverlay(); return { status: 'completed' as const }; },
    }));

    // Workspace new/open — the ProjectSwitcher dropdown was removed from the
    // TopBar; the File menu drives its modal (hosted by ProjectModalHost).
    cleanups.push(registerCommand({
      id: 'project.new',
      title: '新建项目',
      execute: () => { getState().openProjectModal('new'); return { status: 'completed' as const }; },
    }));

    cleanups.push(registerCommand({
      id: 'project.open',
      title: '打开项目',
      execute: () => { getState().openProjectModal('open'); return { status: 'completed' as const }; },
    }));

    // Game flows — a "project" is a game here, so the File menu's 新建/打开 drive
    // the GameSwitcher: game.new opens its new-game dialog, game.open expands its
    // dropdown (the game list). project.new/open above stay registered but are
    // no longer menu-referenced (kept per request — the modal host still runs the
    // project-id sync).
    cleanups.push(registerCommand({
      id: 'game.new',
      title: '新建游戏',
      execute: () => { getState().openGameModal(); return { status: 'completed' as const }; },
    }));

    cleanups.push(registerCommand({
      id: 'game.open',
      title: '打开游戏（游戏列表）',
      execute: () => { getState().setGameSwitcherOpen(true); return { status: 'completed' as const }; },
    }));

    // game.pick — switch directly to a specific game by slug. Drives the File →
    // 打开最近 submenu (each recent-game row dispatches this with its slug). Same
    // store.switchGame mechanism the game.switch action + game-list modal use —
    // no second code path, just a command-bus entry so the menu can reach it.
    cleanups.push(registerCommand({
      id: 'game.pick',
      title: '切换到游戏',
      execute: (args) => {
        const slug = (args as { slug?: unknown } | undefined)?.slug;
        if (typeof slug !== 'string' || !slug) return { status: 'rejected' as const };
        void getState().switchGame(slug);
        return { status: 'completed' as const };
      },
    }));

    // Remaining actions (workbench.list_plugins / workbench.open_plugin /
    // console.clear / console.read / network.clear / session.* / game.switch)
    // stay in lib/builtin-actions.ts for now — they're consumed by
    // action-registry (AI's tool registry). PR 3 will unify.

    return () => {
      // Reverse order so first-registered is torn down last (T9 fixup lesson).
      // `.slice()` clones the array — never mutate the closed-over `cleanups`
      // directly with `.reverse()` or repeat unloads would break.
      for (const c of cleanups.slice().reverse()) c();
    };
  },
};
