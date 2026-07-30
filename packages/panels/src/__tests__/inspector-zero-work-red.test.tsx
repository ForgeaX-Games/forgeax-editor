import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const panel = readFileSync(resolve(import.meta.dir, '..', 'Inspector.tsx'), 'utf8');

describe('Inspector zero-work contracts', () => {
  it('does not subscribe fields through the global document signal', () => {
    expect(panel).toContain('useSyncExternalStore(subscribe, getSnapshot, getSnapshot);');
    expect(panel).toContain('mounted.subscribe(listener)');
    expect(panel).not.toContain('useDocVersion();');
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
    expect(panel).toContain('axis === undefined ? (typeof raw === \'number\' ? raw : fallback)');
  });
});
