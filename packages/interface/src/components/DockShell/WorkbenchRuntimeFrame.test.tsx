import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkbenchCatalogEntry } from '@forgeax/workbench-host/browser';
import {
  TRUSTED_WORKBENCH_SANDBOX,
  WorkbenchRuntimeFrame,
  workbenchFrameContext,
} from './WorkbenchRuntimeFrame';

const descriptor: WorkbenchCatalogEntry = {
  extensionId: '@forgeax-extension/wb-game-video',
  runtimeId: 'runtime-video',
  title: 'Video Game Studio',
  surface: 'split',
  runtimeUrl: '/__workbench__/v1/extension/runtime-video/',
};

describe('WorkbenchRuntimeFrame', () => {
  test('projects game and runtime identity into formal Host endpoints', () => {
    expect(workbenchFrameContext(descriptor, 'game/one')).toMatchObject({
      extensionId: '@forgeax-extension/wb-game-video',
      runtimeId: 'runtime-video',
      gameId: 'game/one',
      endpoints: {
        gamePackage: '/__workbench__/v1/games/game%2Fone/package?runtimeId=runtime-video',
        extensionApi: '/__workbench__/v1/extension/runtime-video?gameId=game%2Fone',
      },
    });
  });

  test('renders one handshake frame for its Page pane', () => {
    (window as Window & { happyDOM?: { setURL(url: string): void } }).happyDOM?.setURL(
      'http://localhost:18920/',
    );
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <WorkbenchRuntimeFrame descriptor={descriptor} gameId="game-one" pane="left" />,
    );
    const frame = container.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe(
      '/__workbench__/v1/extension/runtime-video/?pane=left',
    );
    expect(frame?.getAttribute('sandbox')).toBe(TRUSTED_WORKBENCH_SANDBOX);
    expect(frame?.getAttribute('data-workbench-runtime')).toBe(descriptor.extensionId);
  });
});
