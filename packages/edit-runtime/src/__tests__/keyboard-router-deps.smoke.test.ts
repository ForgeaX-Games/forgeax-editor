import { afterEach, describe, expect, it } from 'bun:test';
import { buildKeyboardRouterDeps } from '../keyboard-router-deps';
import { setViewportQuadrant } from '../viewport/viewport-quadrant';

const EXPECTED_KEYS = [
  'dispatch',
  'getEntitySelection',
  'getAssetSelection',
  'getLastSelectionDomain',
  'isPlayMode',
  'getDisplay',
  'getInputTarget',
  'deleteEntities',
  'duplicateEntities',
  'hideEntities',
  'showAllHidden',
  'hideUnselected',
  'selectAllEntities',
  'duplicateAsset',
  'undo',
  'redo',
  'save',
  'handleViewportKeyDown',
] as const;

describe('buildKeyboardRouterDeps — remaining legacy router bridge', () => {
  afterEach(() => setViewportQuadrant({ run: 'edit', display: 'scene', control: 'editor' }));

  it('contains no migrated focus-routing dependencies', () => {
    const deps = buildKeyboardRouterDeps();
    const record = deps as unknown as Record<string, unknown>;
    expect(Object.keys(deps).sort()).toEqual([...EXPECTED_KEYS].sort());
    for (const key of EXPECTED_KEYS) expect(typeof record[key]).toBe('function');
    for (const removed of [
      'renameEntity', 'deleteAssets', 'renameAsset', 'selectAllAssets',
      'getFolderSelection', 'getPathSelection', 'deleteFolders', 'deletePathItems',
    ]) {
      expect(record[removed]).toBeUndefined();
    }
  });

  it('keeps viewport lifecycle and non-migrated selection reads live', () => {
    const deps = buildKeyboardRouterDeps();
    setViewportQuadrant({ run: 'play', display: 'game', control: 'editor' });
    expect(deps.isPlayMode()).toBe(true);
    expect(deps.getDisplay()).toBe('game');
    expect(deps.getEntitySelection()).toEqual([]);
    expect(deps.getAssetSelection()).toEqual([]);
    expect(['entity', 'asset', 'folder', null]).toContain(deps.getLastSelectionDomain());
  });

  it('keeps command-registry entity actions behind the gateway bridge', () => {
    const deps = buildKeyboardRouterDeps();
    const root = { kind: 'spawnEntity', name: 'Router Root' };
    deps.dispatch(root);
    const rootId = (root as typeof root & { _id?: number })._id;
    expect(rootId).toBeNumber();
    const child = { kind: 'spawnEntity', name: 'Router Child', parent: rootId };
    deps.dispatch(child);
    const childId = (child as typeof child & { _id?: number })._id;
    expect(childId).toBeNumber();

    deps.selectAllEntities();
    expect(deps.getEntitySelection()).toEqual(expect.arrayContaining([rootId, childId]));

    deps.hideEntities([rootId!]);
    deps.showAllHidden();
    deps.hideUnselected();
    deps.duplicateEntities([childId!]);
    deps.deleteEntities([rootId!]);
    deps.dispatch({ kind: 'setSelectionMany', ids: [] });
  });

  it('keeps the remaining asset, history, save, and viewport callbacks live', () => {
    const deps = buildKeyboardRouterDeps();
    expect(deps.getInputTarget()).toBe('editor');

    deps.duplicateAsset('missing-asset', 'assets/Missing.pack.json');
    deps.undo();
    deps.redo();
    deps.save();

    deps.handleViewportKeyDown({
      type: 'keydown',
      key: 'Unbound',
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    } as KeyboardEvent);
  });
});
