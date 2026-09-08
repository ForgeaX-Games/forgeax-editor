import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const main = readFileSync(resolve(import.meta.dir, '../main.ts'), 'utf8');
const executionHost = readFileSync(resolve(import.meta.dir, '../execution-host.ts'), 'utf8');
const executionBootstrap = readFileSync(resolve(import.meta.dir, '../execution-bootstrap.ts'), 'utf8');
const watchPolicy = readFileSync(resolve(import.meta.dir, '../../vite.config.ts'), 'utf8');

describe('Play runtime follows engine preview startup', () => {
  test('createApp consumes the shader plugin bundler adapter instead of a hardcoded manifest URL', () => {
    expect(main).toContain("from 'virtual:forgeax/bundler'");
    expect(main).toContain('...forgeaxBundlerAdapter()');
    expect(main).not.toContain("shaderManifestUrl: '/preview/shaders/manifest.json'");
    expect(executionHost).toContain('forgeaxBundlerAdapter()');
    expect(executionHost).not.toContain("shaderManifestUrl: '/preview/shaders/manifest.json'");
  });

  test('refreshes the runtime catalog before loading defaultScene', () => {
    expect(main).toContain('refreshPlayCatalogUntilReady(assets');
    expect(main).toContain('requiredGuid: requiredScene');
    expect(main.indexOf('refreshPlayCatalogUntilReady')).toBeLessThan(main.indexOf('assets.loadByGuid<SceneAsset>'));
    expect(executionBootstrap).toContain('await assets.refreshCatalog()');
  });

  test('activates Cordis game plugins through engine loadGame / gameHost', () => {
    expect(main).toContain('resolvePlayGameActivation');
    expect(main).toContain('activatePlayGame');
    expect(main).toContain('const gameHost: GameHost = {');
    expect(main).toContain('publishCarrierBootFailure(error)');
  });

  test('boot failures dismiss the Loading overlay', () => {
    const publisher = main.indexOf('function publishCarrierBootFailure');
    const hide = main.indexOf('hideLoadingOverlay();', publisher);
    expect(publisher).toBeGreaterThanOrEqual(0);
    expect(hide).toBeGreaterThan(publisher);
    expect(hide).toBeLessThan(main.indexOf('const detail = bootErrorRecord(error);'));
  });

  test('Vite watch policy ignores host-games tsconfig remounts', () => {
    expect(watchPolicy).toContain('...PLAY_RUNTIME_STATIC_WATCH_IGNORES');
  });

  test('Play HMR websocket is not the preview HTML document path', () => {
    expect(watchPolicy).toContain('hmr: playViteHmrOptions()');
    expect(watchPolicy).toContain('path: PLAY_VITE_HMR_PATH');
  });

  test('execution realm heartbeat listens for engine frame-submitted', () => {
    expect(executionBootstrap).toContain("event.kind === 'frame-submitted'");
    expect(executionBootstrap).not.toContain('renderer.subscribeFrameEnd');
  });

  test('completed-frame heartbeat publishes on the first submitted frame', () => {
    const heartbeat = readFileSync(resolve(import.meta.dir, '../completed-frame-heartbeat.ts'), 'utf8');
    expect(heartbeat).toContain('The first completed frame publishes immediately');
    expect(heartbeat).toContain('frames += 1;');
    const initBranch = heartbeat.indexOf('if (sampleStartedAt === undefined || lastHeartbeatAt === undefined)');
    const firstPublish = heartbeat.indexOf('return { fps: lastFps, sentinel };', initBranch);
    const skipFirst = heartbeat.indexOf('return undefined;', initBranch);
    expect(initBranch).toBeGreaterThanOrEqual(0);
    expect(firstPublish).toBeGreaterThan(initBranch);
    expect(skipFirst === -1 || skipFirst > firstPublish).toBe(true);
  });
});
