// packages/interface/src/core/extensions/builtin-menus.ts
//
// Declares the built-in top-menu-bar items via `menu-registry.registerMenuItem`.
// One extension declaratively populates BRAND / FILE / EDIT / WINDOW / BUILD /
// SELECT / HELP so the web renderer (T6/T7) and the Tauri native bridge (T5)
// share the exact same SSOT (menu-registry) — same UI, one place to edit.
//
// An item WITHOUT a `commandId` is intentionally disabled — it renders as a
// greyed-out placeholder for a capability we haven't wired yet (the registry
// defaults `enabled` to `!!commandId`, so no explicit `enabled: () => false`
// is needed). Once the underlying command lands, the only change is adding
// `commandId` here — the item will light up automatically.
//
// Mirrors the style of `builtin-commands.ts`: a single `AppExtension` whose
// `setup(ctx)` calls the registrar for every item, collects the cleanups, and
// returns a reverse-order cleanup runner.

import type { AppExtension } from '../app-shell/types';
import { registerMenuItem, type MenuItemDef } from '../../lib/menu-registry';
import { isPanelVisible } from '../../components/DockShell/DockRegion';
import { useShellStore } from '../../store';

// Window-menu `checked()` predicates read from the DockRegion module-level
// visibility mirror (interface-owned SSOT — kept in sync via
// onDidAddPanel/onDidRemovePanel). Non-reactive is fine: Radix rebuilds
// dropdown content on every open, so `checked()` runs at open-time and
// reflects the current state.
const isVisible = (id: string) => () => isPanelVisible(id);
// Chat panel visibility lives in the store slice; the panel itself is always
// mounted, `chatpanelCollapsed` flips its collapsed state — invert for
// "checked = visible".
const isChatpanelOpen = () => !useShellStore.getState().chatpanelCollapsed;

export const builtinMenusExtension: AppExtension = {
  id: 'builtin-menus',
  version: '1.0.0',
  setup() {
    const cleanups: Array<() => void> = [];

    // Every item to register — sorted by menu / group / order so the shape
    // reads top-to-bottom the way it renders. The registrar itself re-sorts
    // by group-first-seen then `order`, so declaration order below is
    // documentation only (except for stable in-group tie-breaks).
    const items: MenuItemDef[] = [
      // ─── BRAND ────────────────────────────────────────────────────────────
      { id: 'brand.settings', menu: 'brand', group: 'app', order: 10,
        labelKey: 'menu.brand.settings', icon: 'settings',
        commandId: 'overlay.open', args: { id: 'settings' } },
      { id: 'brand.about', menu: 'brand', group: 'about', order: 10,
        labelKey: 'menu.brand.about', icon: 'info',
        commandId: 'overlay.open', args: { id: 'settings', param: 'about' } },
      { id: 'brand.checkUpdate', menu: 'brand', group: 'about', order: 20,
        labelKey: 'menu.brand.checkUpdate', icon: 'refresh-cw' },

      // ─── FILE ─────────────────────────────────────────────────────────────
      // Labels unchanged (文本不变); the LOGIC now targets games — a project is a
      // game here. 新建项目 → new-game dialog; 打开项目 / 打开最近 → the GameSwitcher
      // dropdown (game list). 关闭项目 stays unimplemented (disabled).
      { id: 'file.newProject', menu: 'file', group: 'project', order: 10,
        labelKey: 'menu.file.newProject', commandId: 'game.new', icon: 'file-plus' },
      { id: 'file.openProject', menu: 'file', group: 'project', order: 20,
        labelKey: 'menu.file.openProject', commandId: 'game.open', icon: 'folder-open' },
      { id: 'file.openRecent', menu: 'file', group: 'project', order: 30,
        labelKey: 'menu.file.openRecent', commandId: 'game.open', icon: 'clock' },
      { id: 'file.closeProject', menu: 'file', group: 'project', order: 40,
        labelKey: 'menu.file.closeProject', icon: 'x' },

      { id: 'file.save', menu: 'file', group: 'file', order: 10,
        labelKey: 'menu.file.save', icon: 'save',
        commandId: 'editor.save', keybinding: 'Ctrl+S' },
      { id: 'file.saveAll', menu: 'file', group: 'file', order: 20,
        labelKey: 'menu.file.saveAll', icon: 'save-all', keybinding: 'Ctrl+Shift+S' },
      // reveal + import: capabilities not confirmed wired yet — leave DISABLED
      // per task brief; flip on `commandId` when T4 confirms.
      { id: 'file.reveal', menu: 'file', group: 'file', order: 30,
        labelKey: 'menu.file.reveal', icon: 'folder-search' },

      { id: 'file.import', menu: 'file', group: 'io', order: 10,
        labelKey: 'menu.file.import', icon: 'upload' },
      { id: 'file.export', menu: 'file', group: 'io', order: 20,
        labelKey: 'menu.file.export', icon: 'package' },
      { id: 'file.package', menu: 'file', group: 'io', order: 30,
        labelKey: 'menu.file.package', icon: 'globe' },

      // ─── EDIT ─────────────────────────────────────────────────────────────
      { id: 'edit.undo', menu: 'edit', group: 'history', order: 10,
        labelKey: 'menu.edit.undo', icon: 'undo-2',
        commandId: 'editor.undo', keybinding: 'Ctrl+Z' },
      { id: 'edit.redo', menu: 'edit', group: 'history', order: 20,
        labelKey: 'menu.edit.redo', icon: 'redo-2',
        commandId: 'editor.redo', keybinding: 'Ctrl+Shift+Z' },

      { id: 'edit.cut', menu: 'edit', group: 'clipboard', order: 10,
        labelKey: 'menu.edit.cut', icon: 'scissors', keybinding: 'Ctrl+X' },
      { id: 'edit.copy', menu: 'edit', group: 'clipboard', order: 20,
        labelKey: 'menu.edit.copy', icon: 'copy', keybinding: 'Ctrl+C' },
      { id: 'edit.paste', menu: 'edit', group: 'clipboard', order: 30,
        labelKey: 'menu.edit.paste', icon: 'clipboard', keybinding: 'Ctrl+V' },
      { id: 'edit.delete', menu: 'edit', group: 'clipboard', order: 40,
        labelKey: 'menu.edit.delete', icon: 'trash-2', danger: true,
        commandId: 'editor.delete' },
      { id: 'edit.copyPath', menu: 'edit', group: 'clipboard', order: 50,
        labelKey: 'menu.edit.copyPath', icon: 'copy' },
      { id: 'edit.copyGuid', menu: 'edit', group: 'clipboard', order: 60,
        labelKey: 'menu.edit.copyGuid', icon: 'hash' },

      { id: 'edit.find', menu: 'edit', group: 'find', order: 10,
        labelKey: 'menu.edit.find', icon: 'search', keybinding: 'Ctrl+F' },

      { id: 'edit.rollback', menu: 'edit', group: 'version', order: 10,
        labelKey: 'menu.edit.rollback', icon: 'rotate-ccw' },

      // ─── WINDOW ───────────────────────────────────────────────────────────
      // Runtime dock ids: editor sub-panels live under `ep:*` (see panelRegistry
      // `buildEditorPanelComponents`), so the toggle args + `checked()` mirror
      // those exact ids. `viewport` is an interface-owned core panel with a bare
      // id. `chat` uses a dedicated store toggle instead of dock-visibility.
      { id: 'window.outline', menu: 'window', group: 'panels', order: 10,
        labelKey: 'menu.window.outline',
        commandId: 'app.panel.toggle', args: { id: 'ep:hierarchy' },
        checked: isVisible('ep:hierarchy') },
      { id: 'window.inspector', menu: 'window', group: 'panels', order: 20,
        labelKey: 'menu.window.inspector',
        commandId: 'app.panel.toggle', args: { id: 'ep:inspector' },
        checked: isVisible('ep:inspector') },
      { id: 'window.files', menu: 'window', group: 'panels', order: 30,
        labelKey: 'menu.window.files',
        commandId: 'app.panel.toggle', args: { id: 'ep:assets' },
        checked: isVisible('ep:assets') },
      { id: 'window.timeline', menu: 'window', group: 'panels', order: 40,
        labelKey: 'menu.window.timeline' },
      { id: 'window.runtime', menu: 'window', group: 'panels', order: 50,
        labelKey: 'menu.window.runtime' },
      { id: 'window.viewport', menu: 'window', group: 'panels', order: 60,
        labelKey: 'menu.window.viewport',
        commandId: 'app.panel.toggle', args: { id: 'viewport' },
        checked: isVisible('viewport') },
      { id: 'window.chat', menu: 'window', group: 'panels', order: 70,
        labelKey: 'menu.window.chat',
        commandId: 'panel.toggle_chatpanel',
        checked: isChatpanelOpen },

      { id: 'window.resetLayout', menu: 'window', group: 'layout', order: 10,
        labelKey: 'menu.window.resetLayout', icon: 'layout-grid',
        commandId: 'app.dock.reset' },
      { id: 'window.fullscreen', menu: 'window', group: 'layout', order: 20,
        labelKey: 'menu.window.fullscreen', icon: 'maximize',
        commandId: 'app.set_fullscreen', args: { value: true } },

      // ─── BUILD ────────────────────────────────────────────────────────────
      { id: 'build.play', menu: 'build', group: 'run', order: 10,
        labelKey: 'menu.build.play', icon: 'play',
        commandId: 'editor.play' },
      { id: 'build.stop', menu: 'build', group: 'run', order: 20,
        labelKey: 'menu.build.stop', icon: 'square',
        commandId: 'editor.stop' },
      { id: 'build.editScene', menu: 'build', group: 'run', order: 30,
        labelKey: 'menu.build.editScene', icon: 'pencil',
        commandId: 'editor.toggleDisplay' },
      // reload: `editor.reloadPreview` currently only emits `preview:reload` on
      // the bus with no consumer wired — clicking would silently no-op (a
      // mock-success path, forbidden by the no-silent-fallback rule). Leave the
      // menu item DISABLED (no commandId) until a listener lands in an L2 owner.
      { id: 'build.reload', menu: 'build', group: 'run', order: 40,
        labelKey: 'menu.build.reload', icon: 'refresh-cw' },

      { id: 'build.export', menu: 'build', group: 'export', order: 10,
        labelKey: 'menu.build.export', icon: 'package' },
      { id: 'build.settings', menu: 'build', group: 'export', order: 20,
        labelKey: 'menu.build.settings', icon: 'settings' },

      // ─── SELECT ───────────────────────────────────────────────────────────
      { id: 'select.all', menu: 'select', group: 'basic', order: 10,
        labelKey: 'menu.select.all', icon: 'box-select',
        commandId: 'editor.selectAll', keybinding: 'Ctrl+A' },
      { id: 'select.none', menu: 'select', group: 'basic', order: 20,
        labelKey: 'menu.select.none', icon: 'square-dashed',
        commandId: 'editor.deselect' },
      { id: 'select.invert', menu: 'select', group: 'basic', order: 30,
        labelKey: 'menu.select.invert', icon: 'flip-horizontal-2' },

      { id: 'select.byType', menu: 'select', group: 'byCond', order: 10,
        labelKey: 'menu.select.byType', icon: 'shapes',
        children: [
          { id: 'select.byType.mesh', menu: 'select', group: 'byCond', order: 10,
            labelKey: 'menu.select.byType.mesh' },
          { id: 'select.byType.light', menu: 'select', group: 'byCond', order: 20,
            labelKey: 'menu.select.byType.light' },
          { id: 'select.byType.camera', menu: 'select', group: 'byCond', order: 30,
            labelKey: 'menu.select.byType.camera' },
          { id: 'select.byType.collider', menu: 'select', group: 'byCond', order: 40,
            labelKey: 'menu.select.byType.collider' },
        ] },
      { id: 'select.marquee', menu: 'select', group: 'byCond', order: 20,
        labelKey: 'menu.select.marquee', icon: 'scan' },

      { id: 'select.frame', menu: 'select', group: 'view', order: 10,
        labelKey: 'menu.select.frame', icon: 'focus',
        commandId: 'editor.frameSelected' },

      // ─── HELP ─────────────────────────────────────────────────────────────
      { id: 'help.docs', menu: 'help', group: 'docs', order: 10,
        labelKey: 'menu.help.docs', icon: 'book-open',
        commandId: 'app.open_url', args: { url: 'https://forgeax.github.io/docs' } },
      { id: 'help.tutorials', menu: 'help', group: 'docs', order: 20,
        labelKey: 'menu.help.tutorials', icon: 'graduation-cap',
        commandId: 'app.open_url', args: { url: 'https://forgeax.github.io/tutorials' } },
      { id: 'help.examples', menu: 'help', group: 'docs', order: 30,
        labelKey: 'menu.help.examples', icon: 'code',
        commandId: 'app.open_url', args: { url: 'https://forgeax.github.io/examples' } },
      { id: 'help.blog', menu: 'help', group: 'docs', order: 40,
        labelKey: 'menu.help.blog', icon: 'newspaper',
        commandId: 'app.open_url', args: { url: 'https://forgeax.github.io/blog' } },

      { id: 'help.games', menu: 'help', group: 'resources', order: 10,
        labelKey: 'menu.help.games', icon: 'gamepad-2',
        commandId: 'app.open_url', args: { url: 'https://forgeax.github.io/games' } },
      { id: 'help.marketplace', menu: 'help', group: 'resources', order: 20,
        labelKey: 'menu.help.marketplace', icon: 'store',
        commandId: 'app.open_url', args: { url: 'https://forgeax.github.io/marketplace' } },
      { id: 'help.changelog', menu: 'help', group: 'resources', order: 30,
        labelKey: 'menu.help.changelog', icon: 'scroll-text',
        commandId: 'app.open_url', args: { url: 'https://forgeax.github.io/changelog' } },

      { id: 'help.shortcuts', menu: 'help', group: 'app', order: 10,
        labelKey: 'menu.help.shortcuts', icon: 'keyboard',
        commandId: 'overlay.open', args: { id: 'settings', param: 'shortcuts' } },
      { id: 'help.askAi', menu: 'help', group: 'app', order: 20,
        labelKey: 'menu.help.askAi', icon: 'sparkles',
        commandId: 'app.open_url', args: { url: 'https://forgeax.github.io/' } },

      { id: 'help.github', menu: 'help', group: 'about', order: 10,
        labelKey: 'menu.help.github', icon: 'github',
        commandId: 'app.open_url', args: { url: 'https://github.com/ForgeaX-Games' } },
      { id: 'help.report', menu: 'help', group: 'about', order: 20,
        labelKey: 'menu.help.report', icon: 'message-circle',
        commandId: 'app.open_url', args: { url: 'https://github.com/ForgeaX-Games' } },
      { id: 'help.about', menu: 'help', group: 'about', order: 30,
        labelKey: 'menu.help.about', icon: 'info',
        commandId: 'overlay.open', args: { id: 'settings', param: 'about' } },
      { id: 'help.license', menu: 'help', group: 'about', order: 40,
        labelKey: 'menu.help.license', icon: 'scale',
        commandId: 'app.open_url', args: { url: 'https://www.apache.org/licenses/LICENSE-2.0' } },
    ];

    for (const def of items) cleanups.push(registerMenuItem(def));

    return () => {
      // Reverse order so first-registered is torn down last — same pattern
      // as builtin-commands.ts; `.slice()` clones the array so a repeat unload
      // doesn't mutate the closed-over `cleanups`.
      for (const c of cleanups.slice().reverse()) c();
    };
  },
};
