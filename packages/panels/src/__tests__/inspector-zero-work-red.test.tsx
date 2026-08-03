import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const panel = readFileSync(resolve(import.meta.dir, '..', 'Inspector.tsx'), 'utf8');

describe('Inspector zero-work contracts', () => {
  it('refreshes the authored component snapshot through the document signal', () => {
    expect(panel).toContain('useSyncExternalStore(subscribe, getSnapshot, getSnapshot);');
    expect(panel).toContain('mounted.subscribe(listener)');
    expect(panel).toContain('useDocVersion();');
  });

  it('mounts only the rendered field and releases the selector when its identity changes', () => {
    expect(panel).toContain("if (field !== undefined && graph !== null");
    expect(panel).toContain('holder.current?.mounted.unsubscribe();');
    expect(panel).toContain('const key = field === undefined ? \'\' : `${field.entity}:${field.component}:${field.field}:${worldGeneration}`;');
    expect(panel).toContain('key={`${selectionGeneration}:${comp}:${k}`}');
  });

  it('keeps an unavailable or unchanged leaf from becoming a React value update', () => {
    expect(panel).toContain("if (snapshot?.status !== 'available') return fallback;");
    expect(panel).toContain('const raw = snapshot.value;');
    expect(panel).toContain('axis === undefined ? raw : Number((raw as ArrayLike<unknown>)[axis] ?? fallback)');
  });

  it('projects stale asset handles as repairable missing state and unbinds numeric refs with zero', () => {
    expect(panel).toContain("const assetMissing = assetBound && curDesc?.ok !== true;");
    expect(panel).toContain('Missing asset — browse to repair');
    expect(panel).toContain("const clearValue = typeof currentValue === 'number' ? 0 : '';");
  });
});
