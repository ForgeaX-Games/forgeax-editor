import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../viewport/ViewportComponent.tsx', import.meta.url), 'utf8');

describe('viewport asset catalog identity', () => {
  it('requires a host runtime binding instead of deriving a catalog from slug', () => {
    expect(source).toContain('runtimeBinding?: RuntimeAssetBinding');
    expect(source).toContain('expectedScope: binding');
    expect(source).not.toContain('resolveViewportPackIndexUrl');
    expect(source).not.toContain('/pack-index/');
  });

  it('does not construct a default import URL', () => {
    expect(source).not.toContain('/__import/');
  });
});
