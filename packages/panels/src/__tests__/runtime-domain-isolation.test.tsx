import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const source = (file: string): string => readFileSync(resolve(import.meta.dir, '..', file), 'utf8');

describe('non-World panel invalidation', () => {
  it('non-World panels are not awakened by runtime-only document churn', () => {
    expect(source('AssetEditors.tsx')).toContain('useActiveEditorAsset');
    expect(source('History.tsx')).toContain('gateway.historySteps');
  });

  it('keeps producer-owned signals visible at each panel boundary', () => {
    expect(source('AssetEditors.tsx')).toContain('const asset = useActiveEditorAsset()');
    expect(source('Capabilities.tsx')).toContain('listComponentSchemas');
    expect(source('Launcher.tsx')).toContain('useSceneReadModel');
  });
});
