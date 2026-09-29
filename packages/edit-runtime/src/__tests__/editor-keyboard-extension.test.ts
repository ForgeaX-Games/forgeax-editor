import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  createApplicationShortcutRegistry,
  type AppExtensionContext,
  type ApplicationShortcut,
} from '@forgeax/app-shell/application';
import { getLocale, setLocale } from '@forgeax/editor-core/i18n';
import * as keyboard from '../keyboard-router-deps';
import { createKeyboardTestDeps } from './keyboard-test-deps';

try { GlobalRegistrator.register(); } catch { /* shared DOM test environment */ }

const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); });

function mount(deps = createKeyboardTestDeps(), extension = keyboard.createEditorKeyboardExtension(deps)) {
  const shortcuts = createApplicationShortcutRegistry();
  // These policy tests exercise the real shortcut registry, not a command-host
  // double. Cross-product command/cleanup proofs use the real host separately.
  const dispose = extension.setup?.({
    registerCommand: () => () => {},
    host: { shortcuts, keybindings: { register: () => () => {} } },
  } as unknown as AppExtensionContext);
  if (typeof dispose !== 'function') throw new Error('keyboard extension must return cleanup');
  disposals.push(dispose, () => shortcuts.dispose());
  return { deps, shortcuts, dispose };
}

function shortcut(shortcuts: readonly ApplicationShortcut[], combo: string): ApplicationShortcut {
  const found = shortcuts.find((entry) => entry.combo === combo);
  if (!found) throw new Error(`Missing shortcut: ${combo}`);
  return found;
}

const key = (key: string, init: KeyboardEventInit = {}): KeyboardEvent =>
  new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });

describe('Editor owns its keyboard contribution', () => {
  it('publishes a per-extension factory beside its Editor callback contract', () => {
    expect('createEditorKeyboardExtension' in keyboard).toBe(true);
  });

  it('contributes thirteen policies without reclaiming focused F2/Delete/Mod+A', () => {
    const { shortcuts } = mount();
    const rows = shortcuts.snapshot();
    expect(rows).toHaveLength(13);
    expect(rows.filter((row) => row.group === 'edit')).toHaveLength(12);
    for (const combo of ['F2', 'Delete', 'Ctrl+A']) {
      expect(rows.some((row) => row.combo === combo)).toBe(false);
    }
    expect(shortcut(rows, 'Esc')).toMatchObject({ group: 'overlay', priority: 20, allowInInput: true });
    for (const row of rows.filter((row) => row.group === 'edit')) expect(row.priority ?? 0).toBe(0);
  });

  it('invalidates retained shortcuts and leaves another host untouched after unload', () => {
    const a = mount();
    const b = mount();
    const retained = a.shortcuts.snapshot();
    a.dispose();
    a.dispose();
    expect(a.shortcuts.snapshot()).toEqual([]);
    const event = key('d', { ctrlKey: true });
    for (const row of retained) {
      expect(row.match(event)).toBe(false);
      expect(row.run(event)).toBe(false);
    }
    expect(a.deps.duplicateEntities).not.toHaveBeenCalled();
    const live = shortcut(b.shortcuts.snapshot(), 'Ctrl+D');
    expect(live.match(event)).toBe(true);
    live.run(event);
    expect(b.deps.duplicateEntities).toHaveBeenCalledWith([7, 11]);
  });

  it('resolves original labels at setup after the host initializes its locale', () => {
    const previous = getLocale();
    disposals.push(() => setLocale(previous));
    setLocale('en');
    const deps = createKeyboardTestDeps();
    const extension = keyboard.createEditorKeyboardExtension(deps);
    setLocale('zh');
    const { shortcuts } = mount(deps, extension);
    expect(shortcut(shortcuts.snapshot(), 'Ctrl+D').label).toBe('复制选中项');
    expect(shortcut(shortcuts.snapshot(), 'H').label).toBe('隐藏选中实体(UE 对标 · 编辑器临时隐藏,不影响游戏)');
  });

  it('updates live labels EN to ZH to EN without changing entry identity or equal-priority ordering', () => {
    const previous = getLocale();
    disposals.push(() => setLocale(previous));
    setLocale('en');
    const { shortcuts, dispose, deps } = mount();
    disposals.push(shortcuts.register({
      combo: 'Later policy', label: 'Later policy', group: 'edit',
      match: () => false, run: () => false,
    }));
    const english = shortcuts.snapshot();
    const duplicate = shortcut(english, 'Ctrl+D');
    expect(shortcut(english, 'Ctrl+D').label).toBe('Duplicate selection');
    expect(english.at(-1)?.combo).toBe('Later policy');
    setLocale('zh');
    const chinese = shortcuts.snapshot();
    expect(shortcut(chinese, 'Ctrl+D').label).toBe('复制选中项');
    expect(chinese).toBe(english);
    expect(shortcut(chinese, 'Ctrl+D')).toBe(duplicate);
    expect(chinese).toHaveLength(14);
    expect(chinese.at(-1)?.combo).toBe('Later policy');
    setLocale('en');
    expect(shortcut(shortcuts.snapshot(), 'Ctrl+D').label).toBe('Duplicate selection');
    expect(shortcuts.snapshot()).toBe(english);
    expect(duplicate.match(key('d', { ctrlKey: true }))).toBe(true);
    expect(deps.duplicateEntities).not.toHaveBeenCalled();
    dispose();
    setLocale('zh');
    expect(shortcuts.snapshot().map((row) => row.combo)).toEqual(['Later policy']);
    for (const row of english.filter((row) => row.combo !== 'Later policy')) {
      expect(row.match(key('d', { ctrlKey: true }))).toBe(false);
      expect(row.run(key('d', { ctrlKey: true }))).toBe(false);
    }
  });
});

describe('Editor hide policy ported from Interface', () => {
  it.each([
    ['H', 'hideEntities'], ['Shift+H', 'hideUnselected'], ['Ctrl+H', 'showAllHidden'],
  ] as const)('%s executes its existing callback and is rejected during Play', (combo, method) => {
    const deps = createKeyboardTestDeps();
    const row = shortcut(mount(deps).shortcuts.snapshot(), combo);
    const event = key('h', { code: 'KeyH', shiftKey: combo === 'Shift+H', ctrlKey: combo === 'Ctrl+H' });
    expect(row.match(event)).toBe(true);
    expect(row.run(event)).toBe(true);
    expect(deps[method]).toHaveBeenCalledTimes(1);
    deps.isPlayMode.mockImplementation(() => true);
    expect(row.run(event)).toBe(false);
    expect(deps[method]).toHaveBeenCalledTimes(1);
  });

  it('preserves empty selection and modified-chord fallthrough', () => {
    const deps = createKeyboardTestDeps({ getEntitySelection: () => [] });
    const rows = mount(deps).shortcuts.snapshot();
    expect(shortcut(rows, 'H').run(key('h'))).toBe(false);
    expect(shortcut(rows, 'Shift+H').run(key('h', { shiftKey: true }))).toBe(false);
    expect(shortcut(rows, 'Ctrl+H').run(key('h', { ctrlKey: true }))).toBe(true);
    for (const combo of ['H', 'Shift+H', 'Ctrl+H']) {
      const row = shortcut(rows, combo);
      expect(row.match(key('h', { code: 'KeyH', ctrlKey: true, shiftKey: true }))).toBe(false);
      expect(row.match(key('h', { code: 'KeyH', altKey: true }))).toBe(false);
    }
    expect(deps.hideEntities).not.toHaveBeenCalled();
    expect(deps.hideUnselected).not.toHaveBeenCalled();
  });
});

describe('Editor viewport and Play policy ported from Interface', () => {
  it('stops Play on plain Escape, including game-owned input, but never claims non-Play Escape', () => {
    const deps = createKeyboardTestDeps({ isPlayMode: () => true, getInputTarget: () => 'game' });
    const row = shortcut(mount(deps).shortcuts.snapshot(), 'Esc');
    expect(row.match(key('Escape'))).toBe(true);
    expect(row.run(key('Escape'))).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith({ kind: 'stop' }, 'human');
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
      expect(row.match(key('Escape', { [modifier]: true }))).toBe(false);
    }
    deps.isPlayMode.mockImplementation(() => false);
    expect(row.match(key('Escape'))).toBe(false);
    expect(row.run(key('Escape'))).toBe(false);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['scene', 'editor', false, 'game'], ['game', 'editor', false, 'scene'],
    ['scene', 'editor', true, 'game'], ['game', 'game', true, 'scene'],
  ] as const)('Shift+G toggles %s with %s input and Play=%s', (display, input, play, expected) => {
    const deps = createKeyboardTestDeps({ getDisplay: () => display, getInputTarget: () => input, isPlayMode: () => play });
    const rows = mount(deps).shortcuts.snapshot();
    const shifted = shortcut(rows, 'Shift+G');
    const event = key('G', { shiftKey: true });
    expect(shifted.match(event)).toBe(true);
    expect(shifted.run(event)).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith({ kind: 'setDisplay', display: expected }, 'human');
    expect(shortcut(rows, 'G').match(key('g'))).toBe(!play && input !== 'game');
  });

  it('routes plain G only when the editor owns Edit input', () => {
    const deps = createKeyboardTestDeps();
    const row = shortcut(mount(deps).shortcuts.snapshot(), 'G');
    expect(row.match(key('g'))).toBe(true);
    row.run(key('g'));
    expect(deps.dispatch).toHaveBeenCalledWith({ kind: 'setDisplay', display: 'game' }, 'human');
    deps.getInputTarget.mockImplementation(() => 'game');
    expect(row.match(key('g'))).toBe(false);
  });

  it('passes the exact original KeyboardEvent through camera, fly, presets and bookmarks', () => {
    const deps = createKeyboardTestDeps();
    const row = shortcut(mount(deps).shortcuts.snapshot(), 'Viewport camera and fly input');
    const events = [
      ...['w', 'e', 'r', 'f', 'a', 's', 'd', 'q', 'v', 'z', 'c', 'Escape', 'Shift', '1', '9'].map((value) => key(value)),
      key('1', { ctrlKey: true }), key('9', { metaKey: true }),
      ...['g', 'h', 'j', 'k'].map((value) => key(value, { altKey: true })),
    ];
    for (const event of events) {
      expect(row.match(event)).toBe(true);
      expect(row.run(event)).toBe(true);
    }
    expect(deps.handleViewportKeyDown.mock.calls.map(([event]) => event)).toEqual(events);
    for (let index = 0; index < events.length; index++) {
      expect(deps.handleViewportKeyDown.mock.calls[index]?.[0]).toBe(events[index]);
    }
    for (const event of [key('x', { altKey: true }), key('h', { altKey: true, ctrlKey: true }),
      key('g', { altKey: true, shiftKey: true }), key('1', { ctrlKey: true, shiftKey: true }),
      { key: undefined } as unknown as KeyboardEvent]) {
      expect(row.match(event)).toBe(false);
    }
    deps.getInputTarget.mockImplementation(() => 'game');
    expect(row.match(key('v'))).toBe(false);
    expect(row.run(key('v'))).toBe(false);
  });

  it('shields arbitrary Play keys only while editor-owned and keeps raw viewport actions', () => {
    const deps = createKeyboardTestDeps({ isPlayMode: () => true });
    const row = shortcut(mount(deps).shortcuts.snapshot(), 'Play editor input shield');
    for (const value of ['Unbound', 'w', 'e', 'r', 'f']) {
      const event = key(value);
      expect(row.match(event)).toBe(true);
      expect(row.run(event)).toBe(true);
      expect(deps.handleViewportKeyDown.mock.calls.at(-1)?.[0]).toBe(event);
    }
    deps.getInputTarget.mockImplementation(() => 'game');
    expect(row.match(key('q'))).toBe(false);
    deps.getInputTarget.mockImplementation(() => 'editor');
    deps.isPlayMode.mockImplementation(() => false);
    expect(row.match(key('q'))).toBe(false);
  });
});

describe('Editor duplicate, history and save policy ported from Interface', () => {
  it('duplicates selected entities, defaults a missing domain, and yields without selection', () => {
    const deps = createKeyboardTestDeps({ getLastSelectionDomain: () => null });
    const row = shortcut(mount(deps).shortcuts.snapshot(), 'Ctrl+D');
    expect(row.run(key('d'))).toBe(true);
    expect(deps.duplicateEntities).toHaveBeenCalledWith([7, 11]);
    deps.getEntitySelection.mockImplementation(() => []);
    expect(row.run(key('d'))).toBe(false);
    expect(row.match(key('NonLatin', { code: 'KeyD', ctrlKey: true }))).toBe(true);
    expect(row.match(key('D', { metaKey: true }))).toBe(true);
    expect(row.match(key('d', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(row.match(key('d', { ctrlKey: true, altKey: true }))).toBe(false);
  });

  it('duplicates every selected asset and preserves the empty asset-domain claim', () => {
    const assets = [{ guid: 'a', name: 'A', packPath: 'a.pack.json' }, { guid: 'b', name: 'B', packPath: 'b.pack.json' }];
    const deps = createKeyboardTestDeps({ getLastSelectionDomain: () => 'asset', getAssetSelection: () => assets });
    const row = shortcut(mount(deps).shortcuts.snapshot(), 'Ctrl+D');
    expect(row.run(key('d'))).toBe(true);
    expect(deps.duplicateAsset.mock.calls).toEqual([['a', 'a.pack.json'], ['b', 'b.pack.json']]);
    expect(deps.duplicateEntities).not.toHaveBeenCalled();
    deps.getAssetSelection.mockImplementation(() => []);
    expect(row.run(key('d'))).toBe(true);
  });

  it.each([
    ['Ctrl+Z', 'z', 'KeyZ', false, 'undo'],
    ['Ctrl+Shift+Z', 'z', 'KeyZ', true, 'redo'],
    ['Ctrl+Y', 'y', 'KeyY', false, 'redo'],
    ['Ctrl+S', 's', 'KeyS', false, 'save'],
  ] as const)('%s retains editable and physical-key routing', (combo, value, code, shift, method) => {
    const deps = createKeyboardTestDeps();
    const row = shortcut(mount(deps).shortcuts.snapshot(), combo);
    expect(row.allowInInput).toBe(true);
    const physical = key('NonLatin', { code, ctrlKey: true, shiftKey: shift });
    expect(row.match(physical)).toBe(true);
    expect(row.match(key(value.toUpperCase(), { metaKey: true, shiftKey: shift }))).toBe(true);
    expect(row.match(key(value, { ctrlKey: true, altKey: true, shiftKey: shift }))).toBe(false);
    expect(row.run(physical)).toBe(true);
    expect(deps[method]).toHaveBeenCalledTimes(1);
  });
});
