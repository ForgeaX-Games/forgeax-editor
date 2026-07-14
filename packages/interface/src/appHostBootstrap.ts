// packages/interface/src/appHostBootstrap.ts
//
// The single place that builds an AppHost + wires the built-in plugin list.
// Studio (which injects Dashboard / Settings / StatusFeeds / surfaces / slots /
// detached / editor concrete plugins) calls this and passes them via
// `overrides.extensions`. Interface-alone callers pass no overrides — no overlays,
// no detached windows, and no editor-specific panels show up (only the L1 base +
// chat remain).
//
// Each manifest's setup is wrapped in a control.beginSetup(m) / try / finally
// endSetup() bracket so host.extend(capability, api) — which requires an
// active setup — always sees the right owner during synchronous plugin boot.

import {
  createAppHost,
  type AppHost,
  type AppHostControl,
  type AppExtension,
  type AppExtensionContext,
} from './core/app-shell';
import { createExtensionLoader } from './core/extension-foundation/loader';
import { foundationCommandsExtension } from './core/extensions/foundation-commands';
import { foundationBusExtension } from './core/extensions/foundation-bus';
import { foundationStorageExtension } from './core/extensions/foundation-storage';
import { foundationPanelsExtension } from './core/extensions/foundation-panels';
import { builtinCommandsExtension } from './core/extensions/builtin-commands';
import { panelsChatExtension } from './core/extensions/panels-chat';
import './core/extensions/session-client.d'; // side-effect: AppHost.session type augmentation
import { sessionClientExtension } from './core/extensions/session-client';
import './core/extensions/workbench-client.d'; // side-effect: AppHost.workbench type augmentation
import { workbenchClientExtension } from './core/extensions/workbench-client';
import './core/extensions/observability.d'; // side-effect: AppHost.observability type augmentation
import { observabilityExtension } from './core/extensions/observability';
import { trajectoryExtension } from './core/extensions/trajectory';
import { consoleLogger } from './core/app-shell/logger';

export interface AppHostBootstrapOverrides {
  /** Studio injects dashboard / settings / surfaces / slots / detached /
   *  editor concrete plugins here. Appended AFTER the built-in list so they
   *  can depend on foundation capabilities. */
  readonly extensions?: readonly AppExtension[];
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

  const contextFactory = (m: AppExtension): AppExtensionContext => ({
    host,
    bus: host.bus,
    storage: host.storage,
    log: consoleLogger,
    registerCommand: (cmd) => host.commands.register(cmd),
    contributePanels: (patch) => foundationPanelsExtension.contributePanels(host, patch),
  });

  const loader = createExtensionLoader<AppExtensionContext, string>({
    capabilities: control.capabilities,
    contextFactory,
    onError: (err, m, phase) =>
      consoleLogger.error(`plugin "${m.id}" ${phase} error`, err),
  });

  // Wrap each manifest so control.beginSetup / endSetup brackets its sync
  // setup frame — host.extend(cap, api) inside setup() needs an active owner.
  const wrap = (m: AppExtension): AppExtension => ({
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

  const manifests: AppExtension[] = [
    foundationCommandsExtension,
    foundationBusExtension,
    foundationStorageExtension,
    foundationPanelsExtension,
    builtinCommandsExtension,
    panelsChatExtension,
    sessionClientExtension,
    workbenchClientExtension,
    observabilityExtension,
    trajectoryExtension,
    ...(overrides.extensions ?? []),
  ].map(wrap);

  await loader.load(manifests);
  await loader.flush();

  const dispose = async (): Promise<void> => {
    await loader.unload();
    control.dispose();
  };

  return { host, control, dispose };
}
