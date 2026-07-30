import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const source = (file: string): string => readFileSync(resolve(import.meta.dir, '..', file), 'utf8');

describe('non-World domain invalidation', () => {
  it('Content Browser does not subscribe to the runtime document pulse', () => {
    const contentBrowser = source('ContentBrowser.tsx');
    const snapshotHook = source('hooks/useAssetBrowserSnapshot.ts');

    expect(contentBrowser).toContain('useAssetBrowserSnapshot');
    expect(snapshotHook).toContain("panelBridge.on('assetsChanged'");
    expect(snapshotHook).toContain('createAssetBrowserReadModel');
  });
});
