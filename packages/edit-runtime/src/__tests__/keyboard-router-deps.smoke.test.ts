// Shape-completeness guard for the shared keyboard-router deps builder.
//
// buildKeyboardRouterDeps is the SSOT both editor hosts (standalone +
// studio) feed into interface's registerKeyboardRouterDeps. The interface router
// destructures a FIXED set of 17 callbacks; a dropped/renamed field would silently
// disable one keyboard gesture (e.g. the G/Esc display-toggle — the very
// regression this extraction fixes). This test pins the exact field set so a
// future edit that drops one fails here at unit time rather than in the running
// editor.
import { afterEach, describe, it, expect } from 'bun:test';
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
  'renameEntity',
  'selectAllEntities',
  'deleteAssets',
  'duplicateAsset',
  'renameAsset',
  'selectAllAssets',
  'getFolderSelection',
  'getPathSelection',
  'deleteFolders',
  'deletePathItems',
  'undo',
  'redo',
  'save',
  'handleViewportKeyDown',
] as const;

describe('buildKeyboardRouterDeps — router dep shape (keyboard-router convergence)', () => {
  afterEach(() => setViewportQuadrant({ run: 'edit', display: 'scene', control: 'editor' }));

  it('returns exactly the interface KeyboardRouterDeps callbacks', () => {
    const deps = buildKeyboardRouterDeps({ confirmDeleteAssets: async () => true, confirmDeleteFolder: async () => true, promptRenameAsset: async () => null });
    const rec = deps as unknown as Record<string, unknown>;
    for (const k of EXPECTED_KEYS) {
      expect(typeof rec[k]).toBe('function');
    }
    // Exact set — no missing, no extra (extra would mean an interface-side field
    // added without updating this guard; missing means a dropped gesture).
    expect(Object.keys(deps).sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  it('derives Play from the viewport quadrant, not the edit gateway mode', () => {
    setViewportQuadrant({ run: 'play', display: 'game', control: 'editor' });
    const deps = buildKeyboardRouterDeps({ confirmDeleteAssets: async () => true, confirmDeleteFolder: async () => true, promptRenameAsset: async () => null });
    expect(deps.isPlayMode()).toBe(true);
    setViewportQuadrant({ run: 'edit', display: 'scene', control: 'editor' });
  });

  it('routes a single selected asset through the host delete guard', async () => {
    const guarded: string[][] = [];
    const deps = buildKeyboardRouterDeps({
      confirmDeleteAssets: async (assets) => {
        guarded.push(assets.map((asset) => asset.guid));
        return false;
      },
      confirmDeleteFolder: async () => true,
      promptRenameAsset: async () => null,
    });

    deps.deleteAssets([{ guid: 'asset-1', name: 'Asset 1', packPath: 'assets/a.pack.json' }]);
    await Promise.resolve();

    expect(guarded).toEqual([['asset-1']]);
  });

  it('projects live router reads and keeps cancelled host mutations inert', async () => {
    const renamePrompts: string[] = [];
    const folderPrompts: string[] = [];
    const deps = buildKeyboardRouterDeps({
      confirmDeleteAssets: async () => false,
      confirmDeleteFolder: async (path) => {
        folderPrompts.push(path);
        return false;
      },
      promptRenameAsset: async (name) => {
        renamePrompts.push(name);
        return null;
      },
    });

    expect(deps.getEntitySelection()).toEqual([]);
    expect(deps.getAssetSelection()).toEqual([]);
    expect(['entity', 'asset', 'folder', null]).toContain(deps.getLastSelectionDomain());
    expect(deps.getDisplay()).toBe('scene');
    expect(deps.getInputTarget()).toBe('editor');
    expect(deps.getFolderSelection?.()).toEqual([]);
    expect(deps.getPathSelection?.()).toEqual([]);

    deps.renameAsset('asset-1', 'assets/Named.pack.json');
    deps.deleteFolders?.([]);
    deps.deletePathItems?.([]);
    await Promise.resolve();

    expect(renamePrompts).toEqual(['Named.pack.json']);
    expect(folderPrompts).toEqual([]);
  });

  it('honors host decisions before dispatching asset and path mutations', async () => {
    const assetPrompts: string[][] = [];
    const folderPrompts: string[] = [];
    const deps = buildKeyboardRouterDeps({
      confirmDeleteAssets: async (assets) => {
        assetPrompts.push(assets.map((asset) => asset.guid));
        return true;
      },
      confirmDeleteFolder: async (path) => {
        folderPrompts.push(path);
        return false;
      },
      promptRenameAsset: async () => ' Renamed ',
    });

    deps.deleteAssets([{ guid: 'missing-asset', name: 'Missing', packPath: 'assets/Missing.pack.json' }]);
    deps.renameAsset('missing-asset', 'assets/Missing.pack.json');
    await Promise.resolve();

    deps.deleteFolders?.([{ path: 'assets/folder' }]);
    await Promise.resolve();
    deps.deletePathItems?.([{ kind: 'dir', path: 'assets/other-folder' }]);
    await Promise.resolve();
    deps.deletePathItems?.([{ kind: 'file', path: 'assets/source.png' }]);
    await Promise.resolve();

    expect(assetPrompts).toEqual([['missing-asset']]);
    expect(folderPrompts).toEqual([
      'assets/folder',
      'assets/other-folder',
      'assets/source.png',
    ]);
  });

  it('blocks folder deletion while a nested text editor owns focus', async () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const folderPrompts: string[] = [];
    const deps = buildKeyboardRouterDeps({
      confirmDeleteAssets: async () => false,
      confirmDeleteFolder: async (path) => {
        folderPrompts.push(path);
        return false;
      },
      promptRenameAsset: async () => null,
    });
    const textInput = {
      tagName: 'INPUT',
      getAttribute: () => 'text',
      isContentEditable: false,
      closest: () => null,
    };

    try {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
          activeElement: {
            tagName: 'DIV',
            shadowRoot: { activeElement: textInput },
            isContentEditable: false,
            closest: () => null,
          },
        },
      });
      deps.deleteFolders?.([{ path: 'assets/blocked' }]);
      await Promise.resolve();
      expect(folderPrompts).toEqual([]);

      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
          activeElement: {
            ...textInput,
            getAttribute: () => 'range',
          },
        },
      });
      deps.deleteFolders?.([{ path: 'assets/allowed' }]);
      await Promise.resolve();
      expect(folderPrompts).toEqual(['assets/allowed']);

      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
          activeElement: {
            tagName: 'DIV',
            isContentEditable: true,
            closest: () => null,
          },
        },
      });
      deps.deleteFolders?.([{ path: 'assets/contenteditable-blocked' }]);
      await Promise.resolve();
      expect(folderPrompts).toEqual(['assets/allowed']);
    } finally {
      if (originalDocument) {
        Object.defineProperty(globalThis, 'document', originalDocument);
      } else {
        delete (globalThis as { document?: Document }).document;
      }
    }
  });

  it('dispatches selection through the gateway-backed router path', () => {
    const deps = buildKeyboardRouterDeps({
      confirmDeleteAssets: async () => false,
      confirmDeleteFolder: async () => false,
      promptRenameAsset: async () => null,
    });
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

    deps.deleteEntities([rootId!]);
    deps.dispatch({ kind: 'setSelectionMany', ids: [] });
  });

  it('dispatches every host-approved path target through gateway validation', async () => {
    const approved: string[] = [];
    const deps = buildKeyboardRouterDeps({
      confirmDeleteAssets: async () => false,
      confirmDeleteFolder: async (path) => {
        approved.push(path);
        return true;
      },
      promptRenameAsset: async () => null,
    });

    deps.deleteFolders?.([{ path: 'assets/../blocked-folder' }]);
    await Promise.resolve();
    deps.deletePathItems?.([{ kind: 'dir', path: 'assets/../blocked-other-folder' }]);
    await Promise.resolve();
    deps.deletePathItems?.([{ kind: 'file', path: 'assets/../blocked-source.png' }]);
    await Promise.resolve();

    expect(approved).toEqual([
      'assets/../blocked-folder',
      'assets/../blocked-other-folder',
      'assets/../blocked-source.png',
    ]);
  });
});
