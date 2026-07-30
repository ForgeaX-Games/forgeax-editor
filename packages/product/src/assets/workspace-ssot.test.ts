import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../../../..');

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('workspace SSOT structural gate', () => {
  test('has one workspace owner and only projections around it', () => {
    const productWorkspace = source('packages/product/src/assets/workspace.ts');
    const browserModel = source('packages/core/src/assets/asset-browser-read-model.ts');
    const browser = source('packages/content-browser/src/ContentBrowser.tsx');
    const graphProjection = source('packages/content-browser/src/hooks/useAssetGraph.ts');

    expect(productWorkspace).toContain('export function createAssetWorkspace');
    expect(browserModel).toContain('const workspace = createAssetWorkspace()');
    expect(browserModel).toContain('workspace: workspaceResult.snapshot');
    expect(browser).not.toContain('useAssetGraph(');
    expect(graphProjection).toContain('Compatibility projection from the workspace relations');
  });

  test('does not add a second watcher state machine or observer mutation path', () => {
    const diskWatch = source('packages/core/src/store/disk-watch.ts');
    const repair = source('packages/core/src/scan/integrity-repair.ts');
    const adapter = source('packages/core/src/product/asset-producer-adapter.ts');

    expect(diskWatch).toContain('createAssetObserverAdapter');
    expect(adapter).toContain('observation never calls it');
    expect(repair).not.toContain('executeAssetImport');
    expect(repair).toContain('recoveryIntents');
  });
});
