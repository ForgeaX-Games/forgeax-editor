import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const source = (file: string): string => readFileSync(resolve(import.meta.dir, '..', file), 'utf8');

describe('asset identity invalidation', () => {
  it('keeps asset selection keyed by GUID instead of a runtime snapshot', () => {
    const contentBrowser = source('ContentBrowser.tsx');
    expect(contentBrowser).toContain('guid: asset.guid');
    expect(contentBrowser).not.toContain('createRuntimeUiGraph');
    expect(contentBrowser).not.toContain('LiveWorldSelectorGraph');
  });

  it('uses the producer completion signal for catalog recovery', () => {
    const snapshotHook = source('hooks/useAssetBrowserSnapshot.ts');
    expect(snapshotHook).toContain("panelBridge.on('assetsChanged'");
    expect(snapshotHook).toContain('model.refresh(hint)');
    expect(snapshotHook).not.toContain('notifyDocChanged');
  });
});
