import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const source = (file: string): string => readFileSync(resolve(import.meta.dir, '..', file), 'utf8');

describe('Asset Inspector identity recovery', () => {
  it('re-reads the asset producer by selected GUID and renders stable missing state', () => {
    const inspector = source('AssetInspector.tsx');
    expect(inspector).toContain('useAssetSelection');
    expect(inspector).toContain('asset.guid');
    expect(inspector).not.toContain('useDocVersion');
    expect(inspector).not.toContain('LiveWorldSelectorGraph');
  });
});
