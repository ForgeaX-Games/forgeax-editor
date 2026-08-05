import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { gamePluginImportUrl, getPlayPluginFailure } from '../index';

describe('asset-resident game plugin loader contract', () => {
  test('keeps plugin imports game-relative under the supplied fs base', () => {
    expect(gamePluginImportUrl(
      'sample/assets/rotator.plugin.ts',
      'sample',
      '/preview/host-games/sample',
    )).toBe('/preview/host-games/sample/assets/rotator.plugin.ts');
  });

  test('projects an import failure as a Play terminal fact', () => {
    expect(getPlayPluginFailure({ errors: [
      { clientPath: 'sample/assets/broken.plugin.ts', message: 'module syntax error' },
    ] })).toEqual({
      code: 'play-plugin-failed',
      hint: 'Play plugin sample/assets/broken.plugin.ts failed to load: module syntax error',
    });
  });

  test('keeps ECS registry delta and system attachment in engine-app', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source).toContain("from '@forgeax/engine-app'");
    expect(source).not.toContain("from '@forgeax/engine-ecs'");
    expect(source).not.toContain('getRegisteredComponents()');
    expect(source).not.toContain('world.addSystem(');
  });
});
