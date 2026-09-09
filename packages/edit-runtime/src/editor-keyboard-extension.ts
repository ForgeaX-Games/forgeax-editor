// Editor keyboard policy and command bodies share one application extension.
// The host owns the only capture listener, contextual precedence, surface/input
// guards and registration identity. Editor owns the raw key policy and Gateway
// callbacks; disposing this extension fences retained and pending commands.
//
// SSOT: forgeax-editor/packages/edit-runtime/src/editor-keyboard-extension.ts (#916)
// Release delta: Studio host has no shortcuts capability yet and still boots
// editorCommandsExtension — see RELEASE_KEYBOARD_FLAGS below. When merging to
// main, flip the flags and drop the release-only import/type shims.

import type { AppExtension } from '@forgeax/interface/core/app-shell/types';
import { t } from '@forgeax/editor-core/i18n';
import type { KeyboardRouterDepsShape } from './keyboard-router-deps';

/** Main registers commands here; release keeps interface editorCommandsExtension. */
const RELEASE_KEYBOARD_FLAGS = {
  ownsEditorCommands: false,
  ownsLegacyShortcuts: false,
} as const;

/** Structural mirror of @forgeax/app-shell/application ApplicationShortcut. */
interface ApplicationShortcut {
  combo: string;
  group: string;
  label: string;
  priority?: number;
  allowInInput?: boolean;
  match: (event: KeyboardEvent) => boolean;
  run: (event: KeyboardEvent) => boolean;
}

type ShortcutsHost = {
  register: (shortcut: ApplicationShortcut) => () => void;
};

const mod = (event: KeyboardEvent): boolean => event.ctrlKey || event.metaKey;
const lowerKey = (event: KeyboardEvent): string =>
  typeof event.key === 'string' ? event.key.toLowerCase() : '';

function editorShortcuts(deps: KeyboardRouterDepsShape): ApplicationShortcut[] {
  const toggleDisplay = (): boolean => {
    deps.dispatch({ kind: 'setDisplay', display: deps.getDisplay() === 'game' ? 'scene' : 'game' }, 'human');
    return true;
  };
  return [
    {
      combo: 'Esc', group: 'overlay', priority: 20, allowInInput: true,
      get label() { return t('editorKeyboard.closeOverlay'); },
      // Before shell Escape (priority 10), including while typing or covered by
      // an overlay. Outside Play the shell still claims plain Escape first.
      match: (event) => event.key === 'Escape' && !mod(event)
        && !event.shiftKey && !event.altKey && deps.isPlayMode(),
      run: () => {
        if (!deps.isPlayMode()) return false;
        deps.dispatch({ kind: 'stop' }, 'human');
        return true;
      },
    },
    {
      combo: 'Ctrl+D', group: 'edit', get label() { return t('editorKeyboard.duplicateSelection'); },
      match: (event) => mod(event) && !event.shiftKey && !event.altKey
        && (event.code === 'KeyD' || lowerKey(event) === 'd'),
      run: () => {
        if ((deps.getLastSelectionDomain() ?? 'entity') === 'asset') {
          for (const asset of deps.getAssetSelection()) deps.duplicateAsset(asset.guid, asset.packPath);
          return true;
        }
        const ids = deps.getEntitySelection();
        if (ids.length === 0) return false;
        deps.duplicateEntities(ids);
        return true;
      },
    },
    {
      combo: 'H', group: 'edit', get label() { return t('editorKeyboard.hideSelected'); },
      match: (event) => !mod(event) && !event.shiftKey && !event.altKey && event.code === 'KeyH',
      run: () => {
        if (deps.isPlayMode()) return false;
        const ids = deps.getEntitySelection();
        if (ids.length === 0) return false;
        deps.hideEntities(ids);
        return true;
      },
    },
    {
      combo: 'Shift+H', group: 'edit', get label() { return t('editorKeyboard.hideUnselected'); },
      match: (event) => !mod(event) && event.shiftKey && !event.altKey && event.code === 'KeyH',
      run: () => {
        if (deps.isPlayMode() || deps.getEntitySelection().length === 0) return false;
        deps.hideUnselected();
        return true;
      },
    },
    {
      combo: 'Ctrl+H', group: 'edit', get label() { return t('editorKeyboard.showAllHidden'); },
      match: (event) => mod(event) && !event.shiftKey && !event.altKey && event.code === 'KeyH',
      run: () => {
        if (deps.isPlayMode()) return false;
        deps.showAllHidden();
        return true;
      },
    },
    {
      combo: 'Shift+G', group: 'edit', get label() { return t('editorKeyboard.toggleViewportGameView'); },
      match: (event) => !mod(event) && event.shiftKey && !event.altKey
        && (event.key === 'g' || event.key === 'G'),
      run: toggleDisplay,
    },
    {
      combo: 'G', group: 'edit', get label() { return t('editorKeyboard.toggleViewportGameView'); },
      match: (event) => !mod(event) && !event.shiftKey && !event.altKey
        && !deps.isPlayMode() && deps.getInputTarget() !== 'game'
        && (event.key === 'g' || event.key === 'G'),
      run: toggleDisplay,
    },
    {
      combo: 'Ctrl+Z', group: 'edit', get label() { return t('editorKeyboard.undo'); }, allowInInput: true,
      match: (event) => mod(event) && !event.altKey && !event.shiftKey
        && (event.code === 'KeyZ' || lowerKey(event) === 'z'),
      run: () => { deps.undo(); return true; },
    },
    {
      combo: 'Ctrl+Shift+Z', group: 'edit', get label() { return t('editorKeyboard.redo'); }, allowInInput: true,
      match: (event) => mod(event) && !event.altKey && event.shiftKey
        && (event.code === 'KeyZ' || lowerKey(event) === 'z'),
      run: () => { deps.redo(); return true; },
    },
    {
      combo: 'Ctrl+Y', group: 'edit', get label() { return t('editorKeyboard.redo'); }, allowInInput: true,
      match: (event) => mod(event) && !event.altKey && !event.shiftKey
        && (event.code === 'KeyY' || lowerKey(event) === 'y'),
      run: () => { deps.redo(); return true; },
    },
    {
      combo: 'Ctrl+S', group: 'edit', get label() { return t('editorKeyboard.save'); }, allowInInput: true,
      match: (event) => mod(event) && !event.altKey && !event.shiftKey
        && (event.code === 'KeyS' || lowerKey(event) === 's'),
      run: () => { deps.save(); return true; },
    },
    {
      combo: 'Viewport camera and fly input', group: 'edit',
      get label() { return t('editorKeyboard.viewportNavigation'); },
      match: (event) => {
        if (deps.getInputTarget() === 'game') return false;
        const key = lowerKey(event);
        if (!key) return false;
        if (event.altKey) {
          return !mod(event) && !event.shiftKey && ['g', 'h', 'j', 'k'].includes(key);
        }
        const cameraKey = !mod(event)
          && (['w', 'e', 'r', 'f', 'a', 's', 'd', 'q', 'v', 'z', 'c', 'escape', 'shift'].includes(key)
            || /^[1-9]$/.test(key));
        const bookmarkKey = mod(event) && !event.shiftKey && /^[1-9]$/.test(key);
        return cameraKey || bookmarkKey;
      },
      run: (event) => {
        if (deps.getInputTarget() === 'game') return false;
        deps.handleViewportKeyDown(event);
        return true;
      },
    },
    {
      combo: 'Play editor input shield', group: 'edit',
      get label() { return t('editorKeyboard.shieldGameInput'); },
      match: () => deps.isPlayMode() && deps.getInputTarget() !== 'game',
      run: (event) => { deps.handleViewportKeyDown(event); return true; },
    },
  ];
}

function readShortcutsHost(host: unknown): ShortcutsHost | null {
  if (!host || typeof host !== 'object' || !('shortcuts' in host)) return null;
  const shortcuts = (host as { shortcuts?: unknown }).shortcuts;
  if (!shortcuts || typeof shortcuts !== 'object' || !('register' in shortcuts)) return null;
  const register = (shortcuts as { register?: unknown }).register;
  return typeof register === 'function' ? shortcuts as ShortcutsHost : null;
}

/** One host's Editor commands and application shortcuts; never installs a listener. */
export function createEditorKeyboardExtension(deps: KeyboardRouterDepsShape): AppExtension {
  return {
    id: 'editor-keyboard',
    version: '1.0.0',
    // Main also requires 'shortcuts'; release host lacks that capability.
    requires: RELEASE_KEYBOARD_FLAGS.ownsLegacyShortcuts
      ? ['commands', 'keybindings', 'shortcuts']
      : ['commands', 'keybindings'],
    setup(context) {
      let active = true;
      const cleanups: Array<() => void> = [];
      const completed = () => ({ status: 'completed' as const });
      const unloaded = () => ({ status: 'rejected' as const, reason: 'Editor keyboard extension unloaded' });
      const dispose = (): void => {
        if (!active) return;
        active = false;
        for (const cleanup of cleanups.splice(0).reverse()) cleanup();
      };
      const commands: ReadonlyArray<readonly [string, string, () => unknown]> = [
        ['editor.play', '开始预览 (Play)', () => { deps.dispatch({ kind: 'play' }, 'human'); return completed(); }],
        ['editor.stop', '停止预览 (Stop)', () => { deps.dispatch({ kind: 'stop' }, 'human'); return completed(); }],
        ['editor.toggleDisplay', '切换 Scene / Game 视图', () => {
          deps.dispatch({ kind: 'setDisplay', display: deps.getDisplay() === 'scene' ? 'game' : 'scene' }, 'human');
          return completed();
        }],
        ['editor.undo', '撤销', () => { deps.undo(); return completed(); }],
        ['editor.redo', '重做', () => { deps.redo(); return completed(); }],
        ['editor.save', '保存', () => { deps.save(); return completed(); }],
        ['editor.selectAll', '全选实体', async () => {
          const result = await context.host.commands.execute<{ status: string }>('text.selectAll');
          if (!active) return unloaded();
          if (result.status !== 'rejected') return result;
          deps.selectAllEntities();
          return completed();
        }],
        ['editor.deselect', '清除选择', () => { deps.dispatch({ kind: 'setSelection', id: null }, 'human'); return completed(); }],
        ['editor.frameSelected', '聚焦所选', () => { deps.dispatch({ kind: 'requestFrame' }, 'human'); return completed(); }],
        ['editor.delete', '删除所选实体', () => {
          const ids = deps.getEntitySelection();
          if (ids.length > 0) deps.deleteEntities(ids);
          return completed();
        }],
        ['editor.reloadPreview', '重载预览 (partial: 事件已发,尚无消费者)', () => {
          context.bus.emit('preview:reload', {});
          return completed();
        }],
        ['editor.restartPreview', '重建预览运行时', () => { deps.restartPreview(); return completed(); }],
      ];
      try {
        if (RELEASE_KEYBOARD_FLAGS.ownsEditorCommands) {
          for (const [id, title, execute] of commands) {
            cleanups.push(context.registerCommand({ id, title, execute: () => active ? execute() : unloaded() }));
          }
        }
        // Document save precedes fallback routing even without a viewport or
        // while an asset editor/input owns focus. The contextual host owns it.
        cleanups.push(context.host.keybindings.register({
          commandId: 'editor.save', keys: 'Mod+S', scope: 'application',
          allowInEditable: true, priority: 100,
        }));
        const shortcutsHost = RELEASE_KEYBOARD_FLAGS.ownsLegacyShortcuts
          ? readShortcutsHost(context.host)
          : null;
        if (shortcutsHost) {
          for (const shortcut of editorShortcuts(deps)) {
            cleanups.push(shortcutsHost.register(shortcut));
          }
        }
      } catch (error) {
        dispose();
        throw error;
      }
      return dispose;
    },
  };
}
