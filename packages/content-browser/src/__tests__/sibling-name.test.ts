import { describe, expect, it } from 'bun:test';
import {
  collectDirectorySiblingNames,
  collectPackAssetSiblingNames,
  collectSceneSiblingSlugs,
  generateDefaultCreateName,
  generateUniqueName,
  normalizeSceneSlug,
  validateSiblingNameForItem,
} from '../sibling-name';
import type { CBAsset, CBFile } from '../types';

const t = ((key: string, params?: { name?: string }) => {
  if (key.includes('duplicateNameAtLocation')) return `dup asset ${params?.name}`;
  if (key.includes('duplicateFolderAtLocation')) return `dup folder ${params?.name}`;
  if (key.includes('duplicateFileAtLocation')) return `dup file ${params?.name}`;
  return key;
}) as import('@forgeax/editor-core/i18n').TFunction;

describe('generateUniqueName', () => {
  it('returns the prefix when free', () => {
    expect(generateUniqueName('NewMaterial', new Set())).toBe('NewMaterial');
  });

  it('increments with no separator like UE', () => {
    const taken = new Set(['NewMaterial', 'NewMaterial1']);
    expect(generateUniqueName('NewMaterial', taken)).toBe('NewMaterial2');
  });
});

describe('collectDirectorySiblingNames', () => {
  it('collects folder and file basenames in a directory', () => {
    const names = collectDirectorySiblingNames('assets', ['assets/Foo', 'assets/bar'], [
      { path: 'assets/chair.glb', name: 'chair.glb' },
    ]);
    expect(names).toEqual(new Set(['Foo', 'bar', 'chair.glb']));
  });

  it('collects top-level folder basenames at game root', () => {
    const names = collectDirectorySiblingNames('', ['assets', 'src', 'assets/Foo'], []);
    expect(names).toEqual(new Set(['assets', 'src']));
  });
});

describe('collectPackAssetSiblingNames', () => {
  it('reads display names from a pack file row', () => {
    const diskFiles = [{
      path: 'assets/Materials.pack.json',
      name: 'Materials.pack.json',
      assets: [{ name: 'Brick' }, { name: 'Glass' }],
    }] as unknown as CBFile[];
    expect(collectPackAssetSiblingNames('assets/Materials.pack.json', diskFiles)).toEqual(new Set(['Brick', 'Glass']));
  });
});

describe('generateDefaultCreateName', () => {
  it('picks the first free material name in a shared pack', () => {
    const data = {
      allDirs: [],
      sceneIds: [],
      diskFiles: [{
        path: 'assets/Materials.pack.json',
        name: 'Materials.pack.json',
        assets: [{ name: 'NewMaterial' }],
      }] as unknown as CBFile[],
    };
    const name = generateDefaultCreateName('NewMaterial', {
      kind: 'pack-assets',
      packPath: 'assets/Materials.pack.json',
    }, data);
    expect(name).toBe('NewMaterial1');
  });
});

describe('normalizeSceneSlug', () => {
  it('normalizes scene ids the same way scene create does', () => {
    expect(normalizeSceneSlug('My Scene 02')).toBe('my-scene-02');
  });
});

describe('collectSceneSiblingSlugs', () => {
  it('merges manifest ids with on-disk scene pack stems', () => {
    const slugs = collectSceneSiblingSlugs(['level-01'], [
      { path: 'assets/scenes/level-02.pack.json', name: 'level-02.pack.json' },
    ]);
    expect(slugs).toEqual(new Set(['level-01', 'level-02']));
  });
});

describe('validateSiblingNameForItem', () => {
  it('flags a duplicate material display name in the same pack', () => {
    const data = {
      allDirs: [],
      sceneIds: [],
      diskFiles: [{
        path: 'assets/Materials.pack.json',
        name: 'Materials.pack.json',
        assets: [],
      }] as unknown as CBFile[],
    };
    const item: CBAsset = {
      type: 'asset',
      guid: 'a',
      kind: 'material',
      name: 'Brick',
      payload: {},
      packPath: 'assets/Materials.pack.json',
      packIndex: 0,
      refs: [],
    };
    data.diskFiles[0]!.assets.push(item);
    data.diskFiles[0]!.assets.push({
      ...item,
      guid: 'b',
      name: 'Glass',
      packIndex: 1,
    });
    expect(validateSiblingNameForItem('Glass', item, data, t)).toMatch(/dup asset Glass/);
    expect(validateSiblingNameForItem('Brick', item, data, t)).toBeNull();
  });
});

