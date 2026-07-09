// packages/interface/src/appHostBootstrap.ts
//
// The single place that builds an AppHost + wires the built-in plugin list.
// Studio (which injects Dashboard / Settings / StatusFeeds / surfaces / slots /
// detached / editor concrete plugins) calls this and passes them via
// `overrides.plugins`. Interface-alone callers pass no overrides — no overlays,
// no detached windows, no editor-specific panels show up (only the L1 base +
// chat + iframe-adapter behave).
//
// Each manifest's setup is wrapped in a control.beginSetup(m) / try / finally
// endSetup() bracket so host.extend(capability, api) — which requires an
// active setup — always sees the right owner during synchronous plugin boot.

import {
  createAppHost,
  type AppHost,
  type AppHostControl,
  type AppPlugin,
  type AppPluginContext,
} from './core/app-shell';
import { createPluginLoader } from './core/plugin-foundation/loader';
import { foundationCommandsPlugin } from './core/plugins/foundation-commands';
import { foundationBusPlugin } from './core/plugins/foundation-bus';
import { foundationStoragePlugin } from './core/plugins/foundation-storage';
import { foundationPanelsPlugin } from './core/plugins/foundation-panels';
import { builtinCommandsPlugin } from './core/plugins/builtin-commands';
import { panelsChatPlugin } from './core/plugins/panels-chat';
import { iframeMessageAdapterPlugin } from './core/plugins/iframe-message-adapter';
import './core/plugins/session-client.d'; // side-effect: AppHost.session type augmentation
import { sessionClientPlugin } from './core/plugins/session-client';
import './core/plugins/workbench-client.d'; // side-effect: AppHost.workbench type augmentation
import { workbenchClientPlugin } from './core/plugins/workbench-client';
import './core/plugins/observability.d'; // side-effect: AppHost.observability type augmentation
import { observabilityPlugin } from './core/plugins/observability';
import { consoleLogger } from './core/app-shell/logger';

export interface AppHostBootstrapOverrides {
  /** Studio injects dashboard / settings / surfaces / slots / detached /
   *  editor concrete plugins here. Appended AFTER the built-in list so they
   *  can depend on foundation capabilities. */
  readonly plugins?: readonly AppPlugin[];
}

export interface AppHostBootstrapResult {
  host: AppHost;
  control: AppHostControl;
  dispose: () => Promise<void>;
}

export async function bootstrapAppHost(
  overrides: AppHostBootstrapOverrides = {},
): Promise<AppHostBootstrapResult> {
  const { host, control } = createAppHost();

  const contextFactory = (m: AppPlugin): AppPluginContext => ({
    host,
    bus: host.bus,
    storage: host.storage,
    log: consoleLogger,
    registerCommand: (cmd) => host.commands.register(cmd),
    contributePanels: (patch) => foundationPanelsPlugin.contributePanels(host, patch),
  });

  const loader = createPluginLoader<AppPluginContext, string>({
    capabilities: control.capabilities,
    contextFactory,
    onError: (err, m, phase) =>
      consoleLogger.error(`plugin "${m.id}" ${phase} error`, err),
  });

  // Wrap each manifest so control.beginSetup / endSetup brackets its sync
  // setup frame — host.extend(cap, api) inside setup() needs an active owner.
  const wrap = (m: AppPlugin): AppPlugin => ({
    ...m,
    async setup(ctx) {
      control.beginSetup(m);
      try {
        return await m.setup(ctx);
      } finally {
        control.endSetup();
      }
    },
  });

  const manifests: AppPlugin[] = [
    foundationCommandsPlugin,
    foundationBusPlugin,
    foundationStoragePlugin,
    foundationPanelsPlugin,
    builtinCommandsPlugin,
    panelsChatPlugin,
    iframeMessageAdapterPlugin,
    sessionClientPlugin,
    workbenchClientPlugin,
    observabilityPlugin,
    ...(overrides.plugins ?? []),
  ].map(wrap);

  await loader.load(manifests);
  await loader.flush();

  const dispose = async (): Promise<void> => {
    await loader.unload();
    control.dispose();
  };

  return { host, control, dispose };
}
