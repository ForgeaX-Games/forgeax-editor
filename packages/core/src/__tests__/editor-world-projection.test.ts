import { afterEach, describe, expect, it } from 'bun:test';

import {
  registerEditorWorldProjectionProvider,
  getEditorWorldProjection,
  EMPTY_EDITOR_WORLD_PROJECTION,
} from '../store/editor-world-projection';

describe('editor-world-projection IoC seam', () => {
  afterEach(() => {
    // Each test registers its own provider; leaving one installed would leak
    // into later suites that expect the empty headless default.
  });

  it('returns the empty projection when no provider is registered', () => {
    expect(getEditorWorldProjection()).toBe(EMPTY_EDITOR_WORLD_PROJECTION);
    expect(getEditorWorldProjection().cameraId).toBeNull();
    expect(getEditorWorldProjection().rows).toEqual([]);
  });

  it('reads Camera-only rows from the registered provider and unregisters', () => {
    const row = {
      id: 7 as never,
      name: 'Editor Camera',
      typeId: 'Camera' as const,
      camera: { fov: 1.047 },
      transform: { pos: [0, 1.5, 9] },
    };
    const unregister = registerEditorWorldProjectionProvider(() => ({
      cameraId: row.id,
      rows: [row],
    }));
    expect(getEditorWorldProjection().cameraId).toBe(7 as never);
    expect(getEditorWorldProjection().rows).toEqual([row]);
    unregister();
    expect(getEditorWorldProjection()).toBe(EMPTY_EDITOR_WORLD_PROJECTION);
  });
});
