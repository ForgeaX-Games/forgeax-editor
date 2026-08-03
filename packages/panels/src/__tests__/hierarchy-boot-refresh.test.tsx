import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const panel = readFileSync(resolve(import.meta.dir, '..', 'Hierarchy.tsx'), 'utf8');

describe('Hierarchy boot refresh', () => {
  it('subscribes the panel to the boot/load signal that can create the runtime graph', () => {
    expect(panel).toContain('const projection = useHierarchyStructureProjection();');
    expect(panel).toContain('useDocVersion();');
  });
});
