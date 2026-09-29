// Editor keyboard policy and command bodies share one application extension.
// The host owns the only capture listener, contextual precedence, surface/input
// guards and registration identity. Editor owns the raw key policy and Gateway
// callbacks; disposing this extension fences retained and pending commands.
import type { AppExtension, ApplicationShortcut } from '@forgeax/app-shell/application';
import { t } from '@forgeax/editor-core/i18n';
import type { KeyboardRouterDepsShape } from './keyboard-router-deps';

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

/** One host's Editor commands and application shortcuts; never installs a listener. */
export function createEditorKeyboardExtension(deps: KeyboardRouterDepsShape): AppExtension {
  return {
    id: 'editor-keyboard',
    version: '1.0.0',
    requires: ['commands', 'keybindings', 'shortcuts'],
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
        ['editor.undo', '撤销', async () => { if (await deps.executeFocusedTextEditAction?.('undo')) return completed(); deps.undo(); return completed(); }],
        ['editor.redo', '重做', async () => { if (await deps.executeFocusedTextEditAction?.('redo')) return completed(); deps.redo(); return completed(); }],
        ['editor.save', '保存', async () => {
          const result = await deps.save();
          return result === false
            ? { status: 'rejected' as const, reason: 'Editor save was rejected' }
            : completed();
        }],
        ['editor.selectAll', '全选实体', async () => {
          const result = await context.host.commands.execute<{ status: string }>('text.selectAll');
          if (!active) return unloaded();
          if (result.status !== 'rejected') return result;
          deps.selectAllEntities();
          return completed();
        }],
        ['editor.deselect', '清除选择', () => { deps.dispatch({ kind: 'setSelection', id: null }, 'human'); return completed(); }],
        ['editor.frameSelected', '聚焦所选', () => { deps.dispatch({ kind: 'requestFrame' }, 'human'); return completed(); }],
        ['editor.delete', '删除所选实体', async () => {
          if (await deps.executeFocusedTextEditAction?.('delete')) return completed();
          const ids = deps.getEntitySelection();
          if (ids.length > 0) deps.deleteEntities(ids);
          return completed();
        }],
        // Existing menu contract: a bus handoff, not a newly invented reload implementation.
        ['editor.reloadPreview', '重载预览 (partial: 事件已发,尚无消费者)', () => {
          context.bus.emit('preview:reload', {});
          return completed();
        }],
        ['editor.restartPreview', '重建预览运行时', () => { deps.restartPreview(); return completed(); }],
      ];
      try {
        for (const [id, title, execute] of commands) {
          cleanups.push(context.registerCommand({ id, title, execute: () => active ? execute() : unloaded() }));
        }
        // Document save precedes fallback routing even without a viewport or
        // while an asset editor/input owns focus. The contextual host owns it.
        cleanups.push(context.host.keybindings.register({
          commandId: 'editor.save', keys: 'Mod+S', scope: 'application',
          allowInEditable: true, priority: 100,
        }));
        // Label getters stay live across locale changes without re-registration,
        // so equal-priority contribution order and retained snapshots stay stable.
        for (const shortcut of editorShortcuts(deps)) {
          cleanups.push(context.host.shortcuts.register(shortcut));
        }
      } catch (error) {
        dispose();
        throw error;
      }
      return dispose;
    },
  };
}
