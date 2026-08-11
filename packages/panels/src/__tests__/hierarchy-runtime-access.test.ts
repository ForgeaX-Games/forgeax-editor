import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { resolveHierarchyRuntimeAccess } from '../hierarchy-state';

const panel = readFileSync(resolve(import.meta.dir, '..', 'Hierarchy.tsx'), 'utf8');

describe('Hierarchy runtime access', () => {
  it('keeps the panel on the shared runtime-access owner', () => {
    expect(panel).toContain('const { usesRemoteProjection: remoteProjection, readOnly } = resolveHierarchyRuntimeAccess({');
    expect(panel).not.toContain('const remoteProjection = remoteContext !== null;');
  });

  it('keeps an in-process Studio projection editable when the local RuntimeUiGraph owns the world', () => {
    expect(resolveHierarchyRuntimeAccess({
      hasLocalRuntimeGraph: true,
      hasRemoteProjection: true,
      gatewayMode: 'edit',
    })).toEqual({ usesRemoteProjection: false, readOnly: false });
  });

  it('lets a projection-only shell use the carrier even when a bootstrap World is present', () => {
    expect(resolveHierarchyRuntimeAccess({
      hasLocalRuntimeGraph: false,
      hasRemoteProjection: true,
      gatewayMode: 'edit',
    })).toEqual({ usesRemoteProjection: true, readOnly: true });
  });

  it('keeps Play read-only even when the local RuntimeUiGraph is present', () => {
    expect(resolveHierarchyRuntimeAccess({
      hasLocalRuntimeGraph: true,
      hasRemoteProjection: false,
      gatewayMode: 'play',
    })).toEqual({ usesRemoteProjection: false, readOnly: true });
  });
});
