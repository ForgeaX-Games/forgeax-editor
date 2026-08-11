import {
  createApp,
  type ExecutionApp,
  type ExecutionBootstrapValue,
} from '@forgeax/engine-app';
import type { RuntimeAssetBinding } from '@forgeax/engine-types';
import type { PointerLockProvider } from '@forgeax/engine-input';
import {
  PLAY_EXECUTION_PROTOCOL,
  type PlayExecutionBootstrapData,
  type PlayExecutionModule,
} from './execution-contract';

export interface StartPlayExecutionOptions {
  readonly canvas: HTMLCanvasElement;
  readonly gameId: string;
  readonly gameEntryUrl: string;
  readonly physics?: 'rapier-3d' | 'rapier-2d';
  readonly runtimeBinding?: RuntimeAssetBinding;
  readonly packIndexUrl?: string;
  readonly gamePluginModules: PlayExecutionBootstrapData['gamePluginModules'];
  readonly lockProvider: PointerLockProvider;
  readonly uiParent: HTMLElement;
}

export interface StartedPlayExecution {
  readonly app: ExecutionApp;
  readonly hostPort: MessagePort;
  disposeHost(): void;
}

export async function startPlayExecution(
  options: StartPlayExecutionOptions,
): Promise<StartedPlayExecution> {
  const channel = new MessageChannel();
  const data: PlayExecutionBootstrapData = {
    protocol: PLAY_EXECUTION_PROTOCOL,
    gameId: options.gameId,
    gameEntryUrl: options.gameEntryUrl,
    ...(options.physics === undefined ? {} : { physics: options.physics }),
    ...(options.runtimeBinding === undefined
      ? {}
      : { runtimeBinding: options.runtimeBinding as unknown as PlayExecutionBootstrapData['runtimeBinding'] }),
    ...(options.packIndexUrl === undefined ? {} : { packIndexUrl: options.packIndexUrl }),
    gamePluginModules: options.gamePluginModules,
  };
  const created = await createApp(
    options.canvas,
    {
      execution: {
        tier: 'auto',
        bootstrap: new URL('./execution-bootstrap.ts', import.meta.url),
        bootstrapData: data as unknown as ExecutionBootstrapValue,
        bootstrapPort: channel.port2,
        startupTimeoutMs: 30_000,
        frameTimeoutMs: 5_000,
      },
      lockProvider: options.lockProvider,
    },
    { shaderManifestUrl: '/preview/shaders/manifest.json' },
  );
  if (!created.ok) {
    channel.port1.close();
    channel.port2.close();
    throw created.error;
  }

  const uiRoot = document.createElement('div');
  uiRoot.id = 'game-ui-root';
  uiRoot.style.cssText = 'position:fixed;inset:0;pointer-events:none';
  options.uiParent.appendChild(uiRoot);
  const cleanups: Array<() => void> = [];
  const registerCleanup = (cleanup: () => void): (() => void) => {
    cleanups.push(cleanup);
    return () => {
      const index = cleanups.indexOf(cleanup);
      if (index >= 0) cleanups.splice(index, 1);
    };
  };

  const gameModule = (await import(
    /* @vite-ignore */ options.gameEntryUrl
  )) as unknown as PlayExecutionModule;
  if (gameModule.host !== undefined) {
    await gameModule.host({
      port: channel.port1,
      uiRoot,
      app: created.value,
      registerCleanup,
    });
  }

  let disposed = false;
  return {
    app: created.value,
    hostPort: channel.port1,
    disposeHost(): void {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups.reverse()) cleanup();
      uiRoot.remove();
      channel.port1.close();
    },
  };
}
