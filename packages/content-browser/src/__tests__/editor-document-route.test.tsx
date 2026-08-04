import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const contentBrowser = readFileSync(resolve(import.meta.dir, '..', 'ContentBrowser.tsx'), 'utf8');

describe('asset activation document route', () => {
  it('opens non-scene assets through the Gateway instead of focusing a Level panel', () => {
    expect(contentBrowser).toContain("gateway.dispatch({ kind: 'openAssetEditor', asset: selectedAsset }, 'human')");
    expect(contentBrowser).not.toContain("app.editor.focus', { panel: 'asset-inspector'");
  });
});
