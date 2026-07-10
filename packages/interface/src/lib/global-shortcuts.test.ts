/**
 * global-shortcuts keyboard-router unit tests (T4-9): dual-domain routing,
 * G four-quadrant display toggle, IME / typing-target guards.
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
  type KeyboardRouterDeps,
  type RouterSelectedAsset,
} from './global-shortcuts';

type Calls = {
  dispatch: Array<[unknown, string?]>;
  deleteEntities: number[][];
  deleteAssets: RouterSelectedAsset[][];
  duplicateEntities: number[][];
  duplicateAsset: Array<[string, string]>;
  renameEntity: number[];
  renameAsset: Array<[string, string]>;
  selectAllEntities: number[];
  selectAllAssets: number[];
};

function mockDeps(over: Partial<KeyboardRouterDeps> = {}): KeyboardRouterDeps & { calls: Calls } {
  const calls: Calls = {
    dispatch: [],
    deleteEntities: [],
    deleteAssets: [],
    duplicateEntities: [],
    duplicateAsset: [],
    renameEntity: [],
    renameAsset: [],
    selectAllEntities: [],
    selectAllAssets: [],
  };
  const base: KeyboardRouterDeps = {
    dispatch: (op, origin) => { calls.dispatch.push([op, origin]); },
    getEntitySelection: () => [],
    getAssetSelection: () => [],
    getLastSelectionDomain: () => 'entity',
    isPlayMode: () => false,
    getDisplay: () => 'scene',
    getInputTarget: () => 'scene',
    deleteEntities: (ids) => { calls.deleteEntities.push(ids); },
    duplicateEntities: (ids) => { calls.duplicateEntities.push(ids); },
    renameEntity: (id) => { calls.renameEntity.push(id); },
    selectAllEntities: () => { calls.selectAllEntities.push(1); },
    deleteAssets: (assets) => { calls.deleteAssets.push(assets); },
    duplicateAsset: (guid, packPath) => { calls.duplicateAsset.push([guid, packPath]); },
    renameAsset: (guid, packPath) => { calls.renameAsset.push([guid, packPath]); },
    selectAllAssets: () => { calls.selectAllAssets.push(1); },
  };
  return Object.assign(base, over, { calls });
}

function findByCombo(sc: ReturnType<typeof buildShortcuts>, combo: string) {
  const s = sc.find((x) => x.combo === combo);
  if (!s) throw new Error(`shortcut ${combo} not registered`);
  return s;
}

beforeEach(() => { registerKeyboardRouterDeps(null); });

describe('keyboard router — dual-domain Delete (AC-C2)', () => {
  it('entity domain + selection → deleteEntities', () => {
    const deps = mockDeps({ getLastSelectionDomain: () => 'entity', getEntitySelection: () => [1, 2] });
    registerKeyboardRouterDeps(deps);
    const del = findByCombo(buildShortcuts(), 'Delete');
    expect(del.run()).toBe(true);
    expect(deps.calls.deleteEntities).toEqual([[1, 2]]);
    expect(deps.calls.deleteAssets).toEqual([]);
  });

  it('asset domain + selection → deleteAssets', () => {
    const asset: RouterSelectedAsset = { guid: 'g1', kind: 'mesh', name: 'a', packPath: 'p', payload: {} };
    const deps = mockDeps({ getLastSelectionDomain: () => 'asset', getAssetSelection: () => [asset] });
    registerKeyboardRouterDeps(deps);
    const del = findByCombo(buildShortcuts(), 'Delete');
    expect(del.run()).toBe(true);
    expect(deps.calls.deleteAssets).toEqual([[asset]]);
  });

  it('no selection in either domain → no-op (returns false)', () => {
    const deps = mockDeps({ getLastSelectionDomain: () => 'entity', getEntitySelection: () => [] });
    registerKeyboardRouterDeps(deps);
    const del = findByCombo(buildShortcuts(), 'Delete');
    expect(del.run()).toBe(false);
    expect(deps.calls.deleteEntities).toEqual([]);
  });

  it('entity + play mode → early return (edit-rejected-in-play), asset still allowed', () => {
    const deps = mockDeps({ getLastSelectionDomain: () => 'entity', getEntitySelection: () => [1], isPlayMode: () => true });
    registerKeyboardRouterDeps(deps);
    const del = findByCombo(buildShortcuts(), 'Delete');
    expect(del.run()).toBe(false);
    expect(deps.calls.deleteEntities).toEqual([]);

    const asset: RouterSelectedAsset = { guid: 'g1', kind: 'mesh', name: 'a', packPath: 'p', payload: {} };
    const deps2 = mockDeps({ getLastSelectionDomain: () => 'asset', getAssetSelection: () => [asset], isPlayMode: () => true });
    registerKeyboardRouterDeps(deps2);
    const del2 = findByCombo(buildShortcuts(), 'Delete');
    expect(del2.run()).toBe(true);
    expect(deps2.calls.deleteAssets).toEqual([[asset]]);
  });
});

describe('keyboard router — Escape Play input exit (AC-Cb4)', () => {
  it('play·game → releases input to editor controls without stopping simulation', () => {
    const deps = mockDeps({ isPlayMode: () => true, getInputTarget: () => 'game' });
    registerKeyboardRouterDeps(deps);
    const esc = findByCombo(buildShortcuts(), 'Esc');
    expect(esc.run()).toBe(true);
    expect(deps.calls.dispatch).toEqual([[{ kind: 'setDisplay', display: 'scene' }, 'human']]);
  });

  it('outside play·game does not dispatch a viewport transition', () => {
    const deps = mockDeps({ isPlayMode: () => true, getInputTarget: () => 'scene' });
    registerKeyboardRouterDeps(deps);
    const esc = findByCombo(buildShortcuts(), 'Esc');
    esc.run();
    expect(deps.calls.dispatch).toEqual([]);
  });
});

describe('keyboard router — G display toggle (AC-Cb4, four-quadrant T4-9)', () => {
  it('edit·scene → toggle to game (dispatch setDisplay game, human)', () => {
    const deps = mockDeps({ getDisplay: () => 'scene', getInputTarget: () => 'scene' });
    registerKeyboardRouterDeps(deps);
    const g = findByCombo(buildShortcuts(), 'G');
    expect(g.run()).toBe(true);
    expect(deps.calls.dispatch).toEqual([[{ kind: 'setDisplay', display: 'game' }, 'human']]);
  });

  it('edit·game → toggle back to scene (edit·game bug fixed, RK-10)', () => {
    const deps = mockDeps({ getDisplay: () => 'game', getInputTarget: () => 'scene' });
    registerKeyboardRouterDeps(deps);
    const g = findByCombo(buildShortcuts(), 'G');
    expect(g.run()).toBe(true);
    expect(deps.calls.dispatch).toEqual([[{ kind: 'setDisplay', display: 'scene' }, 'human']]);
  });

  it('play·scene → toggle (scene input, not game — G still belongs to editor)', () => {
    const deps = mockDeps({ getDisplay: () => 'scene', getInputTarget: () => 'scene', isPlayMode: () => true });
    registerKeyboardRouterDeps(deps);
    const g = findByCombo(buildShortcuts(), 'G');
    expect(g.run()).toBe(true);
    expect(deps.calls.dispatch).toEqual([[{ kind: 'setDisplay', display: 'game' }, 'human']]);
  });

  it('play·game (inputTarget=game) → does NOT intercept or exit Play (yields G to the game, T0-10)', () => {
    const deps = mockDeps({
      getDisplay: () => 'game',
      getInputTarget: () => 'game',
      isPlayMode: () => true,
    });
    registerKeyboardRouterDeps(deps);
    const g = findByCombo(buildShortcuts(), 'G');
    expect(g.run()).toBe(false);
    expect(deps.calls.dispatch).toEqual([]);
  });
});

describe('keyboard router — F2 / Ctrl+D / Ctrl+A routing (AC-C3/C4/C6)', () => {
  it('F2 asset domain → renameAsset', () => {
    const asset: RouterSelectedAsset = { guid: 'g1', kind: 'mesh', name: 'a', packPath: 'p', payload: {} };
    const deps = mockDeps({ getLastSelectionDomain: () => 'asset', getAssetSelection: () => [asset] });
    registerKeyboardRouterDeps(deps);
    const f2 = findByCombo(buildShortcuts(), 'F2');
    expect(f2.run()).toBe(true);
    expect(deps.calls.renameAsset).toEqual([['g1', 'p']]);
  });

  it('Ctrl+D entity domain → duplicateEntities (returns true → wrapper preventDefault)', () => {
    const deps = mockDeps({ getLastSelectionDomain: () => 'entity', getEntitySelection: () => [7] });
    registerKeyboardRouterDeps(deps);
    const cd = findByCombo(buildShortcuts(), 'Ctrl+D');
    expect(cd.run()).toBe(true);
    expect(deps.calls.duplicateEntities).toEqual([[7]]);
  });

  it('Ctrl+A asset domain → selectAllAssets', () => {
    const deps = mockDeps({ getLastSelectionDomain: () => 'asset' });
    registerKeyboardRouterDeps(deps);
    const ca = findByCombo(buildShortcuts(), 'Ctrl+A');
    expect(ca.run()).toBe(true);
    expect(deps.calls.selectAllAssets).toEqual([1]);
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
