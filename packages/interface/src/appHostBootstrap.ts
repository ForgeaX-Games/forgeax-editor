// packages/interface/src/appHostBootstrap.ts
//
// The single place that builds an AppHost + wires the built-in extension list.
// Studio (which injects Dashboard / Settings / StatusFeeds / surfaces / slots /
// detached / editor concrete extensions) calls this and passes them via
// `overrides.extensions`. Interface-alone callers pass no overrides — no overlays,
// no detached windows, and no editor-specific panels show up (only the L1 base +
// chat remain).
//
// Each manifest's setup is wrapped in a control.beginSetup(m) / try / finally
// endSetup() bracket so host.extend(capability, api) — which requires an
// active setup — always sees the right owner during synchronous extension boot.
// The wrap is also where declarative `contributes` lands (ADR 0025 M2): panels
// contributions are registered before setup() runs and removed together with
// the extension's cleanup, so a pure-UI extension needs no setup at all.

import {
  createAppHost,
  type AppHost,
  type AppHostControl,
  type AppExtension,
  type AppExtensionContext,
} from './core/app-shell';
import type { ExtensionManifest, Cleanup } from './core/extension-foundation/types';
import type { HostCapability } from './core/app-shell/types';
import { createExtensionLoader } from './core/extension-foundation/loader';
import { foundationCommandsExtension } from './core/extensions/foundation-commands';
import { foundationBusExtension } from './core/extensions/foundation-bus';
import { foundationStorageExtension } from './core/extensions/foundation-storage';
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

  const contextFactory = (m: ExtensionManifest<HostCapability, AppExtensionContext>): AppExtensionContext => ({
    host,
    bus: host.bus,
    storage: host.storage,
    log: consoleLogger,
    registerCommand: (cmd) => host.commands.register(cmd),
    contributePanels: (patch) => control.contributePanels(m.id, patch),
    contributePanelActions: (actions) => control.contributePanelActions(m.id, actions),
    contributePanelControls: (controls) => control.contributePanelControls(m.id, controls),
  });

  const loader = createExtensionLoader<AppExtensionContext, string>({
    capabilities: control.capabilities,
    contextFactory,
    onError: (err, m, phase) =>
      consoleLogger.error(`extension "${m.id}" ${phase} error`, err),
  });

  // Wrap each manifest so control.beginSetup / endSetup brackets its sync
  // setup frame — host.extend(cap, api) inside setup() needs an active owner.
  // The wrap also applies declarative `contributes.panels` BEFORE setup() and
  // composes its removal into the extension's cleanup (reverse order), and
  // supplies the loader-required setup shim for contributes-only extensions.
  const wrap = (m: AppExtension): ExtensionManifest<HostCapability, AppExtensionContext> => ({
    ...m,
    async setup(ctx) {
      control.beginSetup(m);
      try {
        const cleanups: Cleanup[] = [];
        if (m.contributes?.panels) {
          cleanups.push(control.contributePanels(m.id, m.contributes.panels));
        }
        if (m.contributes?.panelActions) {
          cleanups.push(control.contributePanelActions(m.id, m.contributes.panelActions));
        }
        if (m.contributes?.panelControls) {
          cleanups.push(control.contributePanelControls(m.id, m.contributes.panelControls));
        }
        const r = await m.setup?.(ctx);
        if (typeof r === 'function') cleanups.push(r);
        if (cleanups.length === 0) return undefined;
        return async () => {
          for (const c of cleanups.slice().reverse()) await c();
        };
      } finally {
        control.endSetup();
      }
    },
  });

  const manifests = [
    foundationCommandsExtension,
    foundationBusExtension,
    foundationStorageExtension,
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
