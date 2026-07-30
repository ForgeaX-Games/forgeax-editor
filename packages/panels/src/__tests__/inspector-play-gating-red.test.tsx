import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const panel = readFileSync(resolve(import.meta.dir, '..', 'Inspector.tsx'), 'utf8');

describe('Inspector Play gating contracts', () => {
  it('routes every Inspector edit through a read-only mutation door', () => {
    expect(panel).toContain('const dispatchMutation = (op: EditorOp) => {');
    expect(panel).toContain('if (readOnly) return;');
    expect(panel).toContain('dispatchMutation({ kind: \'setComponent\'');
    expect(panel).toContain('dispatchMutation({ kind: \'bindAssetRef\'');
    expect(panel).not.toContain('gateway.dispatch({ kind: \'setComponent\'');
  });

  it('keeps Stop and stale-selection identity on the existing generation boundary', () => {
    expect(panel).toContain('const readOnly = gateway.mode === \'play\';');
    expect(panel).toContain('const selectionGeneration = `${sel ?? \'none\'}:${worldGeneration}:${gateway.mode}`;');
    expect(panel).toContain('key={`${selectionGeneration}:${comp}:${k}`}');
    expect(panel).toContain('key={`${selectionGeneration}:${r.key}`}');
  });
});
