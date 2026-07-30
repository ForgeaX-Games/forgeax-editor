import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const source = (file: string): string => readFileSync(resolve(import.meta.dir, '..', file), 'utf8');

describe('non-World panels subscription red path', () => {
  it('does not let runtime-only publish wake non-World panels', () => {
    for (const file of ['History.tsx', 'Capabilities.tsx', 'Launcher.tsx']) {
      expect(source(file), file).not.toContain('useDocVersion');
    }
    expect(source('AssetInspector.tsx')).not.toContain('useDocVersion');
  });

  it('preserves the producer-owned read paths and DOM contracts', () => {
    expect(source('History.tsx')).toContain('data-testid="panel-history"');
    expect(source('Capabilities.tsx')).toContain('data-testid="panel-capabilities"');
    expect(source('Launcher.tsx')).toContain('data-testid="panel-launcher"');
    expect(source('AssetInspector.tsx')).toContain('data-testid="panel-asset-inspector"');
  });
});
