import { createEditorKeyboardExtension } from '../editor-keyboard-extension';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  bindViewportRuntimeClient,
  gateway,
  getSelectionList } from '@forgeax/editor-core';
import {
  TRANSPORT_PROTOCOL_VERSION,
  VIEWPORT_RUNTIME_CONTRACT_VERSION,
  type ViewportRuntimeIdentity,
} from '@forgeax/editor-product';
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
  // Viewport 恢复动作:反馈卡片的「重启渲染进程 / 重新加载预览 / 重连运行时」
  // 三个主操作都经命令总线走它重建 Play/运行时表面。属视口生命周期,不是被
  // 迁走的 focus-routing 依赖。
  'restartPreview',
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

  it('prefers live viewport selection over a stale empty runtime snapshot', () => {
    const runtime: ViewportRuntimeIdentity = {
      version: VIEWPORT_RUNTIME_CONTRACT_VERSION,
      runtimeId: 'edit-runtime',
      runtimeGeneration: 1,
      carrierId: 'frame-1',
      carrierKind: 'iframe',
    };
    const dispose = bindViewportRuntimeClient(
      runtime,
      {
        request: async (request) => ({
          jsonrpc: '2.0',
          version: TRANSPORT_PROTOCOL_VERSION,
          id: request.id,
          correlationId: request.correlationId,
          result: {},
        }),
        dispose: () => {},
      });
    try {
      const deps = buildKeyboardRouterDeps();
      const spawned = { kind: 'spawnEntity', name: 'Pick Target' } as const;
      gateway.dispatch(spawned as never, 'human');
      const id = (spawned as typeof spawned & { _id?: number })._id;
      expect(id).toBeNumber();
      gateway.dispatch({ kind: 'setSelection', id: id! } as never, 'human');
      expect(getSelectionList().size).toBe(1);
      expect(deps.getEntitySelection()).toEqual([id!]);
    } finally {
      dispose();
    }
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

describe('createEditorKeyboardExtension — IDE assembly hook', () => {
  it('exports the main-aligned keyboard extension factory', () => {
    const extension = createEditorKeyboardExtension(buildKeyboardRouterDeps());
    expect(extension.id).toBe('editor-keyboard');
    expect(extension.requires).toContain('keybindings');
    expect(extension.requires).toContain('commands');
  });
});
