// packages/interface/src/core/extensions/editor-commands.ts
//
// Command-bus wrappers for editor-domain actions (Play/Stop/Save/Undo/Redo/
// select-all/delete/frame/toggle-display/deselect/…). These commands are the
// single entry point the top menu bar (builtin-menus.ts) and the keyboard
// router share so palette/menu/shortcut hit the same call path.
//
// The interface package is editor-agnostic (lint:agnostic forbids importing
// @forgeax/editor), so every command routes through the injected
// KeyboardRouterDeps — the host editor (studio/main.tsx) calls
// registerKeyboardRouterDeps() at boot BEFORE <App> mounts, and each execute
// resolves the deps LAZILY via getKeyboardRouterDeps(). Capture-at-setup
// would freeze deps to null since setup runs during bootstrapAppHost() which
// happens before main.tsx has finished mounting <App>; lazy resolution keeps
// this file boot-order-safe regardless of whether registration happened first.
//
// import + reveal: NOT registered. Content-browser import and OS file-reveal
// live outside KeyboardRouterDeps and can't be reached editor-agnostically
// from L1. The corresponding menu items in builtin-menus.ts carry no
// commandId and stay disabled — the correct signal for a not-yet-wired
// capability. Flip them on when a dep or command later lands.
//
// reloadPreview: registered as a best-effort event emit (`preview:reload` on
// ctx.bus). No listener consumes it yet — the Play iframe self-reload lives
// in @forgeax/editor/PlaySurface which L1 cannot import. Emitting the event
// keeps the menu item live and gives a future HMR/preview owner a stable hook
// to subscribe to without touching this file.

import type { AppExtension } from '../app-shell/types';
import { getKeyboardRouterDeps } from '../../lib/global-shortcuts';

/** Resolve the injected router deps or throw a clear error naming the missing
 *  wiring — makes a mis-boot fail loudly at command-invoke time instead of
 *  silently no-op'ing. */
function requireDeps(): NonNullable<ReturnType<typeof getKeyboardRouterDeps>> {
  const deps = getKeyboardRouterDeps();
  if (!deps) throw new Error('editor-commands: editor deps not injected (host must call registerKeyboardRouterDeps before invoking editor.* commands)');
  return deps;
}

export const editorCommandsExtension: AppExtension = {
  id: 'editor-commands',
  version: '1.0.0',
  requires: ['commands'],
  setup(ctx) {
    const { registerCommand } = ctx;
    const cleanups: Array<() => void> = [];

    cleanups.push(registerCommand({
      id: 'editor.play',
      title: '开始预览 (Play)',
      execute: () => {
        requireDeps().dispatch({ kind: 'play' }, 'human');
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(registerCommand({
      id: 'editor.stop',
      title: '停止预览 (Stop)',
      execute: () => {
        requireDeps().dispatch({ kind: 'stop' }, 'human');
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(registerCommand({
      id: 'editor.toggleDisplay',
      title: '切换 Scene / Game 视图',
      execute: () => {
        const deps = requireDeps();
        const next = deps.getDisplay() === 'scene' ? 'game' : 'scene';
        deps.dispatch({ kind: 'setDisplay', display: next }, 'human');
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(registerCommand({
      id: 'editor.undo',
      title: '撤销',
      execute: () => {
        requireDeps().undo();
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(registerCommand({
      id: 'editor.redo',
      title: '重做',
      execute: () => {
        requireDeps().redo();
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(registerCommand({
      id: 'editor.save',
      title: '保存',
      execute: () => {
        requireDeps().save();
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(registerCommand({
      id: 'editor.selectAll',
      title: '全选实体',
      execute: () => {
        requireDeps().selectAllEntities();
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(registerCommand({
      id: 'editor.deselect',
      title: '清除选择',
      execute: () => {
        requireDeps().dispatch({ kind: 'setSelection', id: null }, 'human');
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(registerCommand({
      id: 'editor.frameSelected',
      title: '聚焦所选',
      execute: () => {
        requireDeps().dispatch({ kind: 'requestFrame' }, 'human');
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(registerCommand({
      id: 'editor.delete',
      title: '删除所选实体',
      execute: () => {
        const deps = requireDeps();
        const ids = deps.getEntitySelection();
        if (ids.length > 0) deps.deleteEntities(ids);
        return { status: 'completed' as const };
      },
    }));

    // Partial: bus event only, no listener wired yet (see file header). A
    // future preview/HMR owner in an L2 package subscribes to 'preview:reload'
    // and forwards to the Play iframe self-reload. `ctx.bus.emit` is typed
    // against AppBusEventMap which extends Record<string, unknown>, so an
    // ad-hoc topic name is accepted with an `unknown` payload.
    cleanups.push(registerCommand({
      id: 'editor.reloadPreview',
      title: '重载预览 (partial: 事件已发,尚无消费者)',
      execute: () => {
        // Not calling requireDeps() — reloadPreview is decoupled from the
        // editor gateway; the current path is a bus-event handoff, and a
        // future consumer may not even need the router deps.
        (ctx.bus.emit as (topic: string, payload: unknown) => void)('preview:reload', {});
        return { status: 'completed' as const };
      },
    }));

    return () => {
      // Reverse order so first-registered is torn down last — same pattern
      // as builtin-commands.ts; `.slice()` clones the array so a repeat
      // unload doesn't mutate the closed-over `cleanups`.
      for (const c of cleanups.slice().reverse()) c();
    };
  },
};
