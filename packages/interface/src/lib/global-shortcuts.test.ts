/**
 * global-shortcuts keyboard-router unit tests (T4-9): dual-domain routing,
 * Shift+G viewport escape/toggle, IME / typing-target guards.
 *
 * The router stays editor-agnostic (lint:agnostic forbids @forgeax/editor), so
 * the edit-domain shortcuts are exercised through injected mock deps — exactly
 * how the host editor wires them in standalone/main.tsx.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
// The interface test harness may already register Happy DOM globally (a shared
// preload), so guard the second registration to avoid "already registered".
try { GlobalRegistrator.register(); } catch { /* already registered by harness */ }

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  buildShortcuts,
  registerKeyboardRouterDeps,
  isComposing,
  isTypingTarget,
  isEditorSurfaceActive,
  type KeyboardRouterDeps,
} from './global-shortcuts';
import { useShellStore } from '../store';
import { setActiveWorkbench } from './workbenches';

type Calls = {
  dispatch: Array<[unknown, string?]>;
  duplicateEntities: number[][];
  duplicateAsset: Array<[string, string]>;
  hideEntities: number[][];
  showAllHidden: number[];
  hideUnselected: number[];
};

function mockDeps(over: Partial<KeyboardRouterDeps> = {}): KeyboardRouterDeps & { calls: Calls } {
  const calls: Calls = {
    dispatch: [],
    duplicateEntities: [],
    duplicateAsset: [],
    hideEntities: [],
    showAllHidden: [],
    hideUnselected: [],
  };
  const base: KeyboardRouterDeps = {
    dispatch: (op, origin) => { calls.dispatch.push([op, origin]); },
    getEntitySelection: () => [],
    getAssetSelection: () => [],
    getLastSelectionDomain: () => 'entity',
    isPlayMode: () => false,
    getDisplay: () => 'scene',
    getInputTarget: () => 'editor',
    deleteEntities: () => {},
    duplicateEntities: (ids) => { calls.duplicateEntities.push(ids); },
    hideEntities: (ids) => { calls.hideEntities.push(ids); },
    showAllHidden: () => { calls.showAllHidden.push(1); },
    hideUnselected: () => { calls.hideUnselected.push(1); },
    selectAllEntities: () => {},
    duplicateAsset: (guid, packPath) => { calls.duplicateAsset.push([guid, packPath]); },
    undo: () => { calls.dispatch.push([{ kind: 'undo' }, 'human']); },
    redo: () => { calls.dispatch.push([{ kind: 'redo' }, 'human']); },
    save: () => { calls.dispatch.push([{ kind: 'saveDocToDisk' }, 'human']); },
    handleViewportKeyDown: (e) => {
      const key = e.key.toLowerCase();
      const op = key === 'w' ? { kind: 'setGizmoMode', mode: 'translate' }
        : key === 'e' ? { kind: 'setGizmoMode', mode: 'rotate' }
          : key === 'r' ? { kind: 'setGizmoMode', mode: 'scale' }
            : key === 'f' ? { kind: 'requestFrame' } : null;
      if (op) calls.dispatch.push([op, 'human']);
    },
  };
  return Object.assign(base, over, { calls });
}

function findByCombo(sc: ReturnType<typeof buildShortcuts>, combo: string) {
  const s = sc.find((x) => x.combo === combo);
  if (!s) throw new Error(`shortcut ${combo} not registered`);
  return s;
}

beforeEach(() => { registerKeyboardRouterDeps(null); });

describe('keyboard router — UE-parity editor hide (H / Ctrl+H / Shift+H)', () => {
  const keyEvent = (init: { code: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }): KeyboardEvent =>
    ({ key: 'h', ...init } as KeyboardEvent);

  it('H + entity selection → hideEntities (one gesture)', () => {
    const deps = mockDeps({ getEntitySelection: () => [7, 8] });
    registerKeyboardRouterDeps(deps);
    const h = findByCombo(buildShortcuts(), 'H');
    expect(h.match(keyEvent({ code: 'KeyH' }))).toBe(true);
    expect(h.run()).toBe(true);
    expect(deps.calls.hideEntities).toEqual([[7, 8]]);
  });

  it('H without selection → no-op (returns false, key falls through)', () => {
    const deps = mockDeps({ getEntitySelection: () => [] });
    registerKeyboardRouterDeps(deps);
    const h = findByCombo(buildShortcuts(), 'H');
    expect(h.run()).toBe(false);
    expect(deps.calls.hideEntities).toEqual([]);
  });

  it('H under Play → early return (edit-rejected-in-play)', () => {
    const deps = mockDeps({ getEntitySelection: () => [7], isPlayMode: () => true });
    registerKeyboardRouterDeps(deps);
    const h = findByCombo(buildShortcuts(), 'H');
    expect(h.run()).toBe(false);
    expect(deps.calls.hideEntities).toEqual([]);
  });

  it('Ctrl+H → showAllHidden', () => {
    const deps = mockDeps({});
    registerKeyboardRouterDeps(deps);
    const ch = findByCombo(buildShortcuts(), 'Ctrl+H');
    expect(ch.match(keyEvent({ code: 'KeyH', ctrlKey: true }))).toBe(true);
    expect(ch.run()).toBe(true);
    expect(deps.calls.showAllHidden).toEqual([1]);
  });

  it('Ctrl+H under Play → early return', () => {
    const deps = mockDeps({ isPlayMode: () => true });
    registerKeyboardRouterDeps(deps);
    const ch = findByCombo(buildShortcuts(), 'Ctrl+H');
    expect(ch.run()).toBe(false);
    expect(deps.calls.showAllHidden).toEqual([]);
  });

  it('Shift+H + selection → hideUnselected (isolate)', () => {
    const deps = mockDeps({ getEntitySelection: () => [3] });
    registerKeyboardRouterDeps(deps);
    const sh = findByCombo(buildShortcuts(), 'Shift+H');
    expect(sh.match(keyEvent({ code: 'KeyH', shiftKey: true }))).toBe(true);
    expect(sh.run()).toBe(true);
    expect(deps.calls.hideUnselected).toEqual([1]);
  });

  it('Shift+H without selection → no-op', () => {
    const deps = mockDeps({ getEntitySelection: () => [] });
    registerKeyboardRouterDeps(deps);
    const sh = findByCombo(buildShortcuts(), 'Shift+H');
    expect(sh.run()).toBe(false);
    expect(deps.calls.hideUnselected).toEqual([]);
  });

  it('Ctrl+Shift+H no longer routes to hide — it is the Changelog binding', () => {
    const deps = mockDeps({});
    registerKeyboardRouterDeps(deps);
    const changelog = findByCombo(buildShortcuts(), 'Ctrl+Shift+H');
    expect(changelog.match(keyEvent({ code: 'KeyH', ctrlKey: true, shiftKey: true }))).toBe(true);
    // The edit-group hide shortcuts must NOT claim the chord.
    const hide = findByCombo(buildShortcuts(), 'Ctrl+H');
    expect(hide.match(keyEvent({ code: 'KeyH', ctrlKey: true, shiftKey: true }))).toBe(false);
    const isolate = findByCombo(buildShortcuts(), 'Shift+H');
    expect(isolate.match(keyEvent({ code: 'KeyH', ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});

describe('keyboard router — Escape Play stop (AC-Cb4)', () => {
  it('play mode → stops the transient play session', () => {
    const deps = mockDeps({ isPlayMode: () => true, getInputTarget: () => 'game' });
    registerKeyboardRouterDeps(deps);
    const esc = findByCombo(buildShortcuts(), 'Esc');
    expect(esc.run()).toBe(true);
    expect(deps.calls.dispatch).toEqual([[{ kind: 'stop' }, 'human']]);
  });

  it('outside play mode does not dispatch a viewport transition', () => {
    const deps = mockDeps({ isPlayMode: () => false, getInputTarget: () => 'editor' });
    registerKeyboardRouterDeps(deps);
    const esc = findByCombo(buildShortcuts(), 'Esc');
    esc.run();
    expect(deps.calls.dispatch).toEqual([]);
  });
});

describe('keyboard router — Shift+G viewport escape/toggle (AC-Cb4, T4-9)', () => {
  it('edit-owned plain G toggles Game View', () => {
    const deps = mockDeps({ getDisplay: () => 'scene', getInputTarget: () => 'editor' });
    registerKeyboardRouterDeps(deps);
    const shortcuts = buildShortcuts();
    const g = findByCombo(shortcuts, 'G');
    expect(g.match({ key: 'g', code: 'KeyG', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false } as KeyboardEvent)).toBe(true);
    expect(g.run()).toBe(true);
    expect(deps.calls.dispatch).toEqual([[{ kind: 'setDisplay', display: 'game' }, 'human']]);
  });

  it('edit·scene + Shift+G → Game View', () => {
    const deps = mockDeps({ getDisplay: () => 'scene', getInputTarget: () => 'editor' });
    registerKeyboardRouterDeps(deps);
    const g = findByCombo(buildShortcuts(), 'Shift+G');
    expect(g.run()).toBe(true);
    expect(deps.calls.dispatch).toEqual([[{ kind: 'setDisplay', display: 'game' }, 'human']]);
  });

  it('edit·game + Shift+G → scene view', () => {
    const deps = mockDeps({ getDisplay: () => 'game', getInputTarget: () => 'editor' });
    registerKeyboardRouterDeps(deps);
    const g = findByCombo(buildShortcuts(), 'Shift+G');
    expect(g.run()).toBe(true);
    expect(deps.calls.dispatch).toEqual([[{ kind: 'setDisplay', display: 'scene' }, 'human']]);
  });

  it('play·scene + Shift+G → ordinary play game display', () => {
    const deps = mockDeps({ getDisplay: () => 'scene', getInputTarget: () => 'editor', isPlayMode: () => true });
    registerKeyboardRouterDeps(deps);
    const g = findByCombo(buildShortcuts(), 'Shift+G');
    expect(g.run()).toBe(true);
    expect(deps.calls.dispatch).toEqual([[{ kind: 'setDisplay', display: 'game' }, 'human']]);
  });

  it('play·game + Shift+G → scene display, even when game owns plain input', () => {
    const deps = mockDeps({
      getDisplay: () => 'game',
      getInputTarget: () => 'game',
      isPlayMode: () => true,
    });
    registerKeyboardRouterDeps(deps);
    const g = findByCombo(buildShortcuts(), 'Shift+G');
    expect(g.run()).toBe(true);
    expect(deps.calls.dispatch).toEqual([[{ kind: 'setDisplay', display: 'scene' }, 'human']]);
  });
});

describe('keyboard router — editor-owned Play key shield', () => {
  it('play editor-owned input consumes arbitrary game keys', () => {
    const deps = mockDeps({ isPlayMode: () => true, getInputTarget: () => 'editor' });
    registerKeyboardRouterDeps(deps);
    const shield = findByCombo(buildShortcuts(), 'Play editor input shield');
    expect(shield.match({ key: 'q', ctrlKey: false, metaKey: false, altKey: false } as KeyboardEvent)).toBe(true);
    expect(shield.run({ key: 'q', ctrlKey: false, metaKey: false, altKey: false } as KeyboardEvent)).toBe(true);
    expect(deps.calls.dispatch).toEqual([]);
  });

  it('keeps editor W/E/R/F actions while shielding game listeners', () => {
    const deps = mockDeps({ isPlayMode: () => true, getInputTarget: () => 'editor' });
    registerKeyboardRouterDeps(deps);
    const shield = findByCombo(buildShortcuts(), 'Play editor input shield');
    shield.run({ key: 'w', ctrlKey: false, metaKey: false, altKey: false } as KeyboardEvent);
    shield.run({ key: 'e', ctrlKey: false, metaKey: false, altKey: false } as KeyboardEvent);
    shield.run({ key: 'r', ctrlKey: false, metaKey: false, altKey: false } as KeyboardEvent);
    shield.run({ key: 'f', ctrlKey: false, metaKey: false, altKey: false } as KeyboardEvent);
    expect(deps.calls.dispatch).toEqual([
      [{ kind: 'setGizmoMode', mode: 'translate' }, 'human'],
      [{ kind: 'setGizmoMode', mode: 'rotate' }, 'human'],
      [{ kind: 'setGizmoMode', mode: 'scale' }, 'human'],
      [{ kind: 'requestFrame' }, 'human'],
    ]);
  });

  it('does not shield when game owns Play input', () => {
    const deps = mockDeps({ isPlayMode: () => true, getInputTarget: () => 'game' });
    registerKeyboardRouterDeps(deps);
    const shield = findByCombo(buildShortcuts(), 'Play editor input shield');
    expect(shield.match({ key: 'q' } as KeyboardEvent)).toBe(false);
  });
});

describe('keyboard router — camera projection, scale, and bookmark keys', () => {
  it('routes camera keys to the viewport handler instead of dropping them', () => {
    const seen: string[] = [];
    const deps = mockDeps({
      handleViewportKeyDown: (event) => { seen.push(`${event.ctrlKey ? 'ctrl+' : ''}${event.key}`); },
    });
    registerKeyboardRouterDeps(deps);
    const route = findByCombo(buildShortcuts(), 'Viewport camera and fly input');
    for (const event of [
      { key: 'v', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false },
      { key: 'z', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false },
      { key: 'c', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false },
      { key: '1', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false },
      { key: '1', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false },
    ]) {
      expect(route.match(event as KeyboardEvent)).toBe(true);
      expect(route.run(event as KeyboardEvent)).toBe(true);
    }
    expect(seen).toEqual(['v', 'z', 'c', '1', 'ctrl+1']);
  });

  it('does not route camera keys while the game owns Play input', () => {
    const deps = mockDeps({ getInputTarget: () => 'game', isPlayMode: () => true });
    registerKeyboardRouterDeps(deps);
    const route = findByCombo(buildShortcuts(), 'Viewport camera and fly input');
    expect(route.match({ key: 'v', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent)).toBe(false);
  });

  it('routes UE view-preset keys Alt+G/H/J/K to the viewport handler', () => {
    const seen: string[] = [];
    const deps = mockDeps({
      handleViewportKeyDown: (event) => { seen.push(`alt+${event.key}`); },
    });
    registerKeyboardRouterDeps(deps);
    const route = findByCombo(buildShortcuts(), 'Viewport camera and fly input');
    for (const key of ['g', 'h', 'j', 'k']) {
      const event = { key, ctrlKey: false, metaKey: false, altKey: true, shiftKey: false } as KeyboardEvent;
      expect(route.match(event)).toBe(true);
      expect(route.run(event)).toBe(true);
    }
    expect(seen).toEqual(['alt+g', 'alt+h', 'alt+j', 'alt+k']);
  });

  it('keeps non-preset Alt combos and modified preset keys out of the viewport route', () => {
    const deps = mockDeps({ handleViewportKeyDown: () => true });
    registerKeyboardRouterDeps(deps);
    const route = findByCombo(buildShortcuts(), 'Viewport camera and fly input');
    const base = { ctrlKey: false, metaKey: false, altKey: true, shiftKey: false };
    // Other Alt+letters stay excluded; Ctrl/Shift variants of the preset keys
    // belong to other shortcuts (Ctrl+H show-all-hidden, Shift+H isolate…).
    expect(route.match({ ...base, key: 'x' } as KeyboardEvent)).toBe(false);
    expect(route.match({ ...base, key: 'h', ctrlKey: true } as KeyboardEvent)).toBe(false);
    expect(route.match({ ...base, key: 'g', shiftKey: true } as KeyboardEvent)).toBe(false);
    // …and while the game owns Play input, presets yield like every camera key.
    const playDeps = mockDeps({ getInputTarget: () => 'game', isPlayMode: () => true });
    registerKeyboardRouterDeps(playDeps);
    const playRoute = findByCombo(buildShortcuts(), 'Viewport camera and fly input');
    expect(playRoute.match({ ...base, key: 'g' } as KeyboardEvent)).toBe(false);
  });
});

describe('keyboard router — remaining Ctrl+D routing', () => {
  it('Ctrl+D entity domain → duplicateEntities (returns true → wrapper preventDefault)', () => {
    const deps = mockDeps({ getLastSelectionDomain: () => 'entity', getEntitySelection: () => [7] });
    registerKeyboardRouterDeps(deps);
    const cd = findByCombo(buildShortcuts(), 'Ctrl+D');
    expect(cd.run()).toBe(true);
    expect(deps.calls.duplicateEntities).toEqual([[7]]);
  });

  it('does not retain focus-owned F2/Delete/Mod+A in the legacy list', () => {
    registerKeyboardRouterDeps(mockDeps());
    const combos = buildShortcuts().map((shortcut) => shortcut.combo);
    expect(combos).not.toContain('F2');
    expect(combos).not.toContain('Delete');
    expect(combos).not.toContain('Ctrl+A');
  });
});

describe('keyboard router — edit-group surface gate (ADR-0029 Phase 0)', () => {
  // The onKey wrapper skips edit-group shortcuts (letting them escape to the
  // focused component / browser) whenever isEditorSurfaceActive() is false, so
  // Remaining edit keys no longer route to a stale scene selection while the
  // user is on another workbench tab or under an overlay.
  beforeEach(() => {
    useShellStore.setState({ activeOverlay: null });
    setActiveWorkbench('scene');
  });

  it('scene workbench + no overlay → active (edit keys act)', () => {
    expect(isEditorSurfaceActive()).toBe(true);
  });

  it('an overlay covering the shell → inactive (edit keys escape)', () => {
    useShellStore.setState({ activeOverlay: 'settings' });
    expect(isEditorSurfaceActive()).toBe(false);
  });

  it('a non-scene workbench tab → inactive (edit keys escape)', () => {
    setActiveWorkbench('ai');
    expect(isEditorSurfaceActive()).toBe(false);
  });
});

describe('keyboard router — IME / typing-target guards (AC-A5)', () => {
  it('isComposing true on keyCode 229 / isComposing / Process key', () => {
    expect(isComposing({ key: 'Process', keyCode: 229, isComposing: true } as KeyboardEvent)).toBe(true);
    expect(isComposing({ key: 'a', keyCode: 0, isComposing: false } as KeyboardEvent)).toBe(false);
  });

  it('isTypingTarget true for INPUT / TEXTAREA / contenteditable', () => {
    expect(isTypingTarget({ target: document.createElement('input') } as KeyboardEvent)).toBe(true);
    expect(isTypingTarget({ target: document.createElement('textarea') } as KeyboardEvent)).toBe(true);
    const ce = document.createElement('div');
    ce.setAttribute('contenteditable', 'true');
    expect(isTypingTarget({ target: ce } as KeyboardEvent)).toBe(true);
  });

  it('isTypingTarget false for plain div and non-Element target (window)', () => {
    expect(isTypingTarget({ target: document.createElement('div') } as KeyboardEvent)).toBe(false);
    expect(isTypingTarget({ target: window } as unknown as KeyboardEvent)).toBe(false);
  });
});
