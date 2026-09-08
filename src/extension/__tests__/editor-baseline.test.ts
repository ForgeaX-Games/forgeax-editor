import { describe, expect, test } from 'bun:test';
import manifest from '../fixtures/editor-baseline.json';

describe('Editor baseline extension contract', () => {
  test('consumes the engine capability contract only', () => {
    expect(manifest.kind).toBe('editor');
    expect(manifest.capabilities).toContain('engine.preview.create');
    expect(manifest.permissions).toEqual(['project:read', 'project:write']);
    expect(JSON.stringify(manifest)).not.toMatch(/agent|engine\.internal/i);
  });
});
