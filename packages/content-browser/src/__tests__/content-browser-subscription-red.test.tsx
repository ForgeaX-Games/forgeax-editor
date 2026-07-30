import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const source = (file: string): string => readFileSync(resolve(import.meta.dir, '..', file), 'utf8');

describe('Content Browser subscription red path', () => {
  it('rejects runtime doc-version wiring while retaining assetsChanged recovery', () => {
    const contentBrowser = source('ContentBrowser.tsx');
    const snapshotHook = source('hooks/useAssetBrowserSnapshot.ts');
    expect(contentBrowser).not.toContain('subscribeDocVersion');
    expect(contentBrowser).not.toContain('useDocVersion');
    expect(snapshotHook).toContain("panelBridge.on('assetsChanged'");
    expect(snapshotHook).toContain('model.refresh(hint)');
  });
});
