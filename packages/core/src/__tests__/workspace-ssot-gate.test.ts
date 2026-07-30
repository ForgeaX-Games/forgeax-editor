import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assetWorkspaceSnapshotToBrowserSnapshot, createAssetWorkspace } from '../public/assets';

const repoRoot = resolve(import.meta.dir, '../../../../');

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('core workspace SSOT gate', () => {
  test('publishes the workspace projection from the core boundary', () => {
    const workspace = createAssetWorkspace();
    expect(workspace).toBeDefined();
    expect(typeof assetWorkspaceSnapshotToBrowserSnapshot).toBe('function');
    expect(source('packages/core/src/assets/asset-browser-read-model.ts')).toContain('workspace?: AssetWorkspaceSnapshot');
  });

  test('guards observer and recovery paths against UI-only or destructive work', () => {
    const observer = source('packages/core/src/product/asset-producer-adapter.ts');
    const watch = source('packages/core/src/store/disk-watch.ts');
    const repair = source('packages/core/src/scan/integrity-repair.ts');

    expect(observer).not.toContain('gateway.dispatch');
    expect(observer).not.toContain('writeFile');
    expect(watch).toContain('observer.observe');
    expect(repair).not.toContain('executeAssetImport');
  });
});
