import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const source = (file: string): string => readFileSync(resolve(import.meta.dir, '..', file), 'utf8');

describe('asset editor document identity', () => {
  it('binds every asset page panel to the active document instead of transient Content Browser selection', () => {
    const editors = source('AssetEditors.tsx');
    expect(editors).toContain('useActiveEditorAsset');
    expect(editors).toContain('ensureAssetCataloged');
    expect(editors).toContain("panelBridge.on('assetsChanged'");
    expect(editors).not.toContain('useAssetSelection');
    expect(editors).not.toContain('useDocVersion');
    expect(editors).not.toContain('LiveWorldSelectorGraph');
  });
});
