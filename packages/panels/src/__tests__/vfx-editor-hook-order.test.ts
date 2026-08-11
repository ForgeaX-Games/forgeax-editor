import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const source = readFileSync(resolve(import.meta.dir, '..', 'VfxEditor.tsx'), 'utf8');

describe('VFX editor async document projection', () => {
  it('keeps the Details selection hook unconditional while the payload becomes resident', () => {
    const start = source.indexOf('export function VfxDetailsPanel');
    const end = source.indexOf('export function VfxTimelinePanel');
    const details = source.slice(start, end);
    expect(details.indexOf('useSelectedNodeId')).toBeGreaterThan(-1);
    expect(details.indexOf('useSelectedNodeId')).toBeLessThan(details.indexOf('if (!state.descriptor)'));
  });
});
