// packages/interface/src/core/plugins/builtin-commands.ts
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

import type { AppPlugin } from '../app-shell/types';
import { useShellStore, type AppMode } from '../../store';
import { setActiveWorkbench } from '../../lib/workbenches';

const getState = () => useShellStore.getState();

export const builtinCommandsPlugin: AppPlugin = {
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
        const mode = (args as { mode?: AppMode })?.mode;
        if (mode !== 'scene' && mode !== 'ai') throw new Error('app.set_mode: mode must be scene | ai');
        setActiveWorkbench(mode);
        getState().setMode(mode);
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
      id: 'app.dock.reset',
      title: 'Reset dock layout',
      execute: () => { ctx.bus.emit('dock:reset', {}); return { status: 'completed' as const }; },
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
