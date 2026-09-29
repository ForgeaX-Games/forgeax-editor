// Cross-product lifecycle proof: real published Interface host and capture router,
// Editor-owned commands/contributions, and the neutral text-edit command owner.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createAppHost, consoleLogger, type AppExtensionContext } from '@forgeax/interface/core/app-shell';
import { builtinCommandsExtension } from '@forgeax/interface/core/extensions/builtin-commands';
import { useGlobalShortcuts } from '@forgeax/interface/lib/global-shortcuts';
import { useShellStore } from '@forgeax/interface/store';
import { createEditorKeyboardExtension, type KeyboardRouterDepsShape } from '@forgeax/editor/keyboard-router-deps';
import { getLocale, setLocale } from '@forgeax/editor-core/i18n';
import { createKeyboardTestDeps } from '../../../packages/edit-runtime/src/__tests__/keyboard-test-deps';

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => { await GlobalRegistrator.unregister(); });

const commandIds = [
  'editor.play', 'editor.stop', 'editor.toggleDisplay', 'editor.undo',
  'editor.redo', 'editor.save', 'editor.selectAll', 'editor.deselect',
  'editor.frameSelected', 'editor.delete', 'editor.reloadPreview', 'editor.restartPreview',
].sort();
const disposals: Array<() => void | Promise<void>> = [];
let previousShell: ReturnType<typeof useShellStore.getState>;
beforeEach(() => {
  previousShell = useShellStore.getState();
  useShellStore.setState({ activeOverlay: null, fullscreen: false });
});
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  document.body.replaceChildren();
  useShellStore.setState(previousShell, true);
});

function createRuntime(withTextCommands = true) {
  const { host, control } = createAppHost();
  disposals.push(() => control.dispose());
  function context(owner: string): AppExtensionContext {
    return {
      host, bus: host.bus, storage: host.storage, log: consoleLogger,
      registerCommand: (command) => host.commands.register(command),
      contributePanels: (patch) => control.contributePanels(owner, patch),
      contributePanelActions: (actions) => control.contributePanelActions(owner, actions),
      contributePanelControls: (controls) => control.contributePanelControls(owner, controls),
      contributePagePlatform: (contribution) => control.contributePagePlatform(owner, contribution),
    };
  }
  if (withTextCommands) {
    control.beginSetup(builtinCommandsExtension);
    try {
      const cleanup = builtinCommandsExtension.setup?.(context(builtinCommandsExtension.id));
      if (typeof cleanup !== 'function') throw new Error('builtin command setup must return cleanup');
      disposals.push(cleanup);
    } finally { control.endSetup(); }
  }
  return {
    host,
    setup(deps: KeyboardRouterDepsShape) {
      const extension = createEditorKeyboardExtension(deps);
      control.beginSetup(extension);
      try {
        const cleanup = extension.setup?.(context(extension.id));
        if (typeof cleanup !== 'function') throw new Error('Editor setup must return cleanup');
        disposals.push(cleanup);
        return cleanup;
      } finally { control.endSetup(); }
    },
    async mountRouter() {
      function Router() { useGlobalShortcuts(host.keybindings, host.shortcuts); return null; }
      const element = document.createElement('div');
      document.body.append(element);
      const root = createRoot(element);
      await act(async () => { root.render(createElement(Router)); });
      disposals.push(async () => { await act(async () => { root.unmount(); }); });
    },
    ids: () => host.commands.list().map(({ id }) => id).filter((id) => id.startsWith('editor.')).sort(),
  };
}

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}
const saveModifiers = () => /mac/i.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

describe('Editor keyboard lifecycle on the real published application host', () => {
  it('registers, executes and removes all twelve commands through unload and remount', async () => {
    const runtime = createRuntime();
    const reload = mock(() => {});
    disposals.push(runtime.host.bus.on('preview:reload', reload));
    for (let mount = 0; mount < 2; mount++) {
      const deps = createKeyboardTestDeps();
      const dispose = runtime.setup(deps);
      expect(runtime.ids()).toEqual(commandIds);
      expect(runtime.host.shortcuts.snapshot()).toHaveLength(13);
      reload.mockClear();
      for (const id of commandIds) expect(await runtime.host.commands.execute(id)).toEqual({ status: 'completed' });
      expect(deps.dispatch.mock.calls).toEqual([
        [{ kind: 'setSelection', id: null }, 'human'], [{ kind: 'requestFrame' }, 'human'],
        [{ kind: 'play' }, 'human'], [{ kind: 'stop' }, 'human'],
        [{ kind: 'setDisplay', display: 'game' }, 'human'],
      ]);
      for (const callback of [deps.undo, deps.redo, deps.save, deps.selectAllEntities, deps.restartPreview]) {
        expect(callback).toHaveBeenCalledTimes(1);
      }
      expect(deps.getEntitySelection).toHaveBeenCalledTimes(1);
      expect(deps.deleteEntities).toHaveBeenCalledWith([7, 11]);
      expect(reload).toHaveBeenCalledWith({});
      expect(reload).toHaveBeenCalledTimes(1);
      dispose();
      expect(runtime.ids()).toEqual([]);
      expect(runtime.host.shortcuts.snapshot()).toEqual([]);
      for (const id of commandIds) await expect(runtime.host.commands.execute(id)).rejects.toThrow('not found');
    }
  });

  it('keeps B command identities and save binding after A cleanup, B setup, repeated A cleanup', async () => {
    const runtime = createRuntime();
    const a = createKeyboardTestDeps();
    const b = createKeyboardTestDeps();
    const removeA = runtime.setup(a);
    removeA();
    runtime.setup(b);
    const commandsB = commandIds.map((id) => runtime.host.commands.get(id));
    await runtime.mountRouter();
    removeA();
    expect(runtime.ids()).toEqual(commandIds);
    expect(commandIds.map((id) => runtime.host.commands.get(id))).toEqual(commandsB);
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    expect(press(input, 's', saveModifiers()).defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(a.save).not.toHaveBeenCalled();
    expect(b.save).toHaveBeenCalledTimes(1);
    expect(runtime.host.shortcuts.snapshot()).toHaveLength(13);
  });

  it('fences every retained command callback after unload', async () => {
    const runtime = createRuntime();
    const deps = createKeyboardTestDeps();
    const reload = mock(() => {});
    disposals.push(runtime.host.bus.on('preview:reload', reload));
    const dispose = runtime.setup(deps);
    const retained = commandIds.map((id) => runtime.host.commands.get(id)!);
    dispose();
    for (const command of retained) expect(await command.execute()).toMatchObject({ status: 'rejected' });
    for (const callback of [deps.dispatch, deps.undo, deps.redo, deps.save, deps.selectAllEntities,
      deps.deleteEntities, deps.restartPreview, reload]) expect(callback).not.toHaveBeenCalled();
  });

  it('updates live shortcut labels without replacing commands or duplicating application save', async () => {
    const previous = getLocale();
    disposals.push(() => setLocale(previous));
    setLocale('en');
    const runtime = createRuntime();
    const deps = createKeyboardTestDeps();
    runtime.setup(deps);
    const commands = commandIds.map((id) => runtime.host.commands.get(id));
    const shortcuts = runtime.host.shortcuts.snapshot();
    await runtime.mountRouter();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale);
      const rows = runtime.host.shortcuts.snapshot();
      expect(rows).toBe(shortcuts);
      expect(rows).toHaveLength(13);
      expect(rows.find((row) => row.combo === 'Ctrl+D')?.label)
        .toBe(locale === 'zh' ? '复制选中项' : 'Duplicate selection');
      for (let index = 0; index < commandIds.length; index++) {
        expect(runtime.host.commands.get(commandIds[index]!)).toBe(commands[index]);
      }
      expect(press(input, 's', saveModifiers()).defaultPrevented).toBe(true);
      await Promise.resolve();
    }
    expect(deps.save).toHaveBeenCalledTimes(2);
  });

  it('keeps two live hosts bound to their own callbacks', async () => {
    const a = createRuntime();
    const b = createRuntime();
    const depsA = createKeyboardTestDeps();
    const depsB = createKeyboardTestDeps();
    const disposeA = a.setup(depsA);
    b.setup(depsB);
    await a.host.commands.execute('editor.save');
    await b.host.commands.execute('editor.save');
    disposeA();
    await b.host.commands.execute('editor.save');
    expect(depsA.save).toHaveBeenCalledTimes(1);
    expect(depsB.save).toHaveBeenCalledTimes(2);
  });

  it('rolls back partial command registration without replacing the existing owner', () => {
    const runtime = createRuntime();
    const existing = { id: 'editor.redo', title: 'Existing owner', execute: () => ({ status: 'completed' }) };
    disposals.push(runtime.host.commands.register(existing));
    expect(() => runtime.setup(createKeyboardTestDeps())).toThrow();
    expect(runtime.ids()).toEqual(['editor.redo']);
    expect(runtime.host.commands.get('editor.redo')).toBe(existing);
    expect(runtime.host.shortcuts.snapshot()).toEqual([]);
  });

  it('rolls back commands and save binding when a later shortcut registration fails', async () => {
    const runtime = createRuntime();
    const register = runtime.host.shortcuts.register;
    let count = 0;
    runtime.host.shortcuts.register = (shortcut) => {
      if (++count === 3) throw new Error('injected shortcut registration failure');
      return register(shortcut);
    };
    try {
      expect(() => runtime.setup(createKeyboardTestDeps())).toThrow('injected shortcut registration failure');
    } finally { runtime.host.shortcuts.register = register; }
    expect(runtime.ids()).toEqual([]);
    expect(runtime.host.shortcuts.snapshot()).toEqual([]);
    await runtime.mountRouter();
    expect(press(document.body, 's', saveModifiers()).defaultPrevented).toBe(false);
  });

  it('removes and restores application save for focused input without a viewport', async () => {
    const runtime = createRuntime();
    const deps = createKeyboardTestDeps();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    await runtime.mountRouter();
    expect(document.querySelector('[data-surface-anchor="edit"]')).toBeNull();
    const dispose = runtime.setup(deps);
    expect(press(input, 's', saveModifiers()).defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(deps.save).toHaveBeenCalledTimes(1);
    dispose();
    expect(press(input, 's', saveModifiers()).defaultPrevented).toBe(false);
    runtime.setup(deps);
    expect(press(input, 's', saveModifiers()).defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(deps.save).toHaveBeenCalledTimes(2);
  });

  it('does not report Ctrl+S as completed when the canonical save is rejected', async () => {
    const runtime = createRuntime();
    const deps = createKeyboardTestDeps();
    deps.save.mockResolvedValue(false);
    runtime.setup(deps);

    await expect(runtime.host.commands.execute('editor.save')).resolves.toEqual({
      status: 'rejected',
      reason: 'Editor save was rejected',
    });
    expect(deps.save).toHaveBeenCalledTimes(1);
  });

  it('preserves real-router Escape precedence: Play stop, then shell close, no non-Play viewport Escape', async () => {
    const runtime = createRuntime();
    const deps = createKeyboardTestDeps();
    runtime.setup(deps);
    await runtime.mountRouter();
    const anchor = document.createElement('div');
    anchor.dataset.surfaceAnchor = 'edit';
    anchor.getClientRects = () => [{ width: 100, height: 100 }] as unknown as DOMRectList;
    document.body.append(anchor);
    expect(press(anchor, 'Escape').defaultPrevented).toBe(false);
    expect(deps.handleViewportKeyDown).not.toHaveBeenCalled();
    useShellStore.setState({ activeOverlay: 'settings' });
    deps.isPlayMode.mockImplementation(() => true);
    expect(press(anchor, 'Escape').defaultPrevented).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith({ kind: 'stop' }, 'human');
    expect(useShellStore.getState().activeOverlay).toBe('settings');
    deps.isPlayMode.mockImplementation(() => false);
    expect(press(anchor, 'Escape').defaultPrevented).toBe(true);
    expect(useShellStore.getState().activeOverlay).toBeNull();
    expect(deps.handleViewportKeyDown).not.toHaveBeenCalled();
  });
});

describe('Editor select-all through the neutral text command', () => {
  it('selects focused input text before falling back to entities', async () => {
    const runtime = createRuntime();
    const deps = createKeyboardTestDeps();
    runtime.setup(deps);
    const input = document.createElement('input');
    input.value = 'api-key';
    document.body.append(input);
    input.focus();
    input.setSelectionRange(3, 3);
    expect(await runtime.host.commands.execute('editor.selectAll')).toEqual({ status: 'completed' });
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(deps.selectAllEntities).not.toHaveBeenCalled();
    input.blur();
    expect(await runtime.host.commands.execute('editor.selectAll')).toEqual({ status: 'completed' });
    expect(deps.selectAllEntities).toHaveBeenCalledTimes(1);
  });

  it('does not fall back for cancellation or a missing text command', async () => {
    const runtime = createRuntime(false);
    const deps = createKeyboardTestDeps();
    runtime.setup(deps);
    await expect(runtime.host.commands.execute('editor.selectAll')).rejects.toThrow('not found');
    disposals.push(runtime.host.commands.register({
      id: 'text.selectAll', title: 'Canceled text selection', execute: () => ({ status: 'cancelled' }),
    }));
    expect(await runtime.host.commands.execute('editor.selectAll')).toEqual({ status: 'cancelled' });
    expect(deps.selectAllEntities).not.toHaveBeenCalled();
  });

  it('fences an in-flight rejected text command after unload and remount', async () => {
    const runtime = createRuntime(false);
    let finish!: (result: { status: string }) => void;
    disposals.push(runtime.host.commands.register({
      id: 'text.selectAll', title: 'Delayed text selection',
      execute: () => new Promise((resolve) => { finish = resolve; }),
    }));
    const a = createKeyboardTestDeps();
    const b = createKeyboardTestDeps();
    const removeA = runtime.setup(a);
    const pending = runtime.host.commands.execute('editor.selectAll');
    removeA();
    runtime.setup(b);
    finish({ status: 'rejected' });
    expect(await pending).toMatchObject({ status: 'rejected', reason: 'Editor keyboard extension unloaded' });
    expect(a.selectAllEntities).not.toHaveBeenCalled();
    expect(b.selectAllEntities).not.toHaveBeenCalled();
  });
});
