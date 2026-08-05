import { describe, expect, it } from 'bun:test';
import { getPlayPluginFailure } from '@forgeax/editor-game-plugins';

describe('Play plugin startup failure projection', () => {
  it('projects the first plugin import error as a structured terminal failure', () => {
    expect(getPlayPluginFailure({ errors: [
      { clientPath: 'sample/assets/broken.plugin.ts', message: 'module syntax error' },
      { clientPath: 'sample/assets/another.plugin.ts', message: 'not reached' },
    ] })).toEqual({
      code: 'play-plugin-failed',
      hint: 'Play plugin sample/assets/broken.plugin.ts failed to load: module syntax error',
    });
  });

  it('keeps a clean plugin scan out of the failure path', () => {
    expect(getPlayPluginFailure({ errors: [] })).toBeNull();
  });
});
