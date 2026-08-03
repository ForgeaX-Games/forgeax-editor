import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const source = readFileSync(resolve(import.meta.dir, '..', 'Inspector.tsx'), 'utf8');

describe('Inspector field subscription red paths', () => {
  it('mounts field selectors and refreshes authored component snapshots', () => {
    expect(source).toContain('createInspectorFieldSelector');
    expect(source).toContain('useSyncExternalStore');
    expect(source).toContain('useDocVersion();');
  });

  it('keeps the existing form and mutation responsibilities in panels', () => {
    expect(source).toContain('ScrubInput');
    expect(source).toContain('gateway.dispatch');
    expect(source).toContain('data-testid={`insp-');
  });
});
