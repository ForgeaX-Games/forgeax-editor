import { describe, expect, test } from 'bun:test';
import { resolvePlaySceneGuid } from '../play-scene-selection';

describe('Play scene selection', () => {
  test('prefers the editor-selected scene passed to the packaged carrier', () => {
    expect(resolvePlaySceneGuid(' selected-scene ', 'default-scene')).toBe('selected-scene');
  });

  test('falls back to forge.json defaultScene for direct preview', () => {
    expect(resolvePlaySceneGuid(null, ' default-scene ')).toBe('default-scene');
  });

  test('returns no scene when neither source declares one', () => {
    expect(resolvePlaySceneGuid('  ', undefined)).toBeUndefined();
  });
});
