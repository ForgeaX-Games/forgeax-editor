// packages/interface/src/core/app-shell/host.ts
import {
  createCommandsRegistry, type CommandsRegistry,
} from '../plugin-foundation/commands';
import { EventBus } from '../plugin-foundation/bus';
import { createContextKeys, type ContextKeysApi } from '../plugin-foundation/context-keys';
import { createStorageApi, type StorageApi } from '../plugin-foundation/storage';
import { createCapabilityRegistry, type CapabilityRegistry } from '../plugin-foundation/capabilities';
import { PluginConflictError } from '../plugin-foundation/errors';
import type {
  AppBusEventMap, AppHost, AppHostBase, AppLogger, AppPlugin, HostCapability,
} from './types';
import { consoleLogger } from './logger';
import { DEFAULT_PANEL_RENDERERS, type PanelRenderers } from '../../components/DockShell/panelRenderers';

const BUILT_IN_CAPS: readonly HostCapability[] = [
  'commands', 'bus', 'storage', 'panels', 'contextKeys',
];

interface ExtensionRecord { capability: HostCapability; owner: string; }

export interface CreateAppHostDeps {
  readonly log?: AppLogger;
  readonly initialPanels?: PanelRenderers;
}

export interface AppHostControl {
  beginSetup(manifest: AppPlugin): void;
  endSetup(): void;
  removeExtensionsByOwner(ownerId: string): void;
  readonly capabilities: CapabilityRegistry<HostCapability>;
  dispose(): void;
}

export interface CreateAppHostResult {
  host: AppHost;
  control: AppHostControl;
}

export function createAppHost(deps: CreateAppHostDeps = {}): CreateAppHostResult {
  const log = deps.log ?? consoleLogger;
  const caps = createCapabilityRegistry<HostCapability>();
  for (const c of BUILT_IN_CAPS) caps.add(c);

  const commands: CommandsRegistry = createCommandsRegistry();
  const bus = new EventBus<AppBusEventMap>();
  const storage: StorageApi = createStorageApi(log);
  const contextKeys: ContextKeysApi = createContextKeys();
  // panels is mutable during boot — plugins call ctx.contributePanels() to
  // merge patches into this container. foundation-panels plugin exposes it
  // as host.panels below.
  const panels: PanelRenderers = { ...DEFAULT_PANEL_RENDERERS, ...deps.initialPanels };

  const extensions: ExtensionRecord[] = [];
  const extensionFields: Record<string, unknown> = {};

  let activeSetup: AppPlugin | null = null;

  const base: AppHostBase = {
    commands, bus, storage, contextKeys, panels,
    get capabilities() { return caps.snapshot(); },
    extend(capability, api) {
      if (activeSetup === null) {
        throw new Error(`[app-shell] host.extend("${String(capability)}") called outside plugin setup`);
      }
      if (!activeSetup.provides?.includes(capability)) {
        throw new PluginConflictError({
          id: String(capability), subRegistryName: 'host.extend',
          existingOwner: '(none)', newOwner: activeSetup.id,
        });
      }
      if (extensionFields[capability as string] !== undefined) {
        const orig = extensions.find((e) => e.capability === capability);
        throw new PluginConflictError({
          id: String(capability), subRegistryName: 'host.extend',
          existingOwner: orig?.owner ?? '(unknown)', newOwner: activeSetup.id,
        });
      }
      if (BUILT_IN_CAPS.includes(capability)) {
        throw new PluginConflictError({
          id: String(capability), subRegistryName: 'host.extend',
          existingOwner: '(built-in)', newOwner: activeSetup.id,
        });
      }
      extensionFields[capability as string] = api;
      extensions.push({ capability, owner: activeSetup.id });
      caps.add(capability);
      bus.emit('capability:added', { capability: String(capability), provider: activeSetup.id });
    },
  };

  const host = new Proxy(base as unknown as AppHost, {
    get(target, prop, receiver): unknown {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === 'string' && prop in extensionFields) return extensionFields[prop];
      return undefined;
    },
    has(target, prop): boolean {
      return prop in target || (typeof prop === 'string' && prop in extensionFields);
    },
    set() { throw new TypeError('[app-shell] host is read-only; use host.extend'); },
    defineProperty() { throw new TypeError('[app-shell] host is read-only; use host.extend'); },
    deleteProperty() { throw new TypeError('[app-shell] host is read-only; use control.removeExtensionsByOwner'); },
    ownKeys(target): ArrayLike<string | symbol> {
      return Reflect.ownKeys(target).concat(
        Object.keys(extensionFields).filter((k) => !Reflect.has(target, k)),
      );
    },
    getOwnPropertyDescriptor(target, prop): PropertyDescriptor | undefined {
      const own = Reflect.getOwnPropertyDescriptor(target, prop);
      if (own) return own;
      if (typeof prop === 'string' && prop in extensionFields) {
        return { value: extensionFields[prop], enumerable: true, configurable: true, writable: false };
      }
      return undefined;
    },
  });

  const control: AppHostControl = {
    beginSetup(m) {
      if (activeSetup !== null) {
        throw new Error(`[app-shell] beginSetup("${m.id}") while "${activeSetup.id}" still active`);
      }
      activeSetup = m;
    },
    endSetup() { activeSetup = null; },
    capabilities: caps,
    removeExtensionsByOwner(ownerId) {
      const indices: number[] = [];
      for (let i = extensions.length - 1; i >= 0; i--) {
        if (extensions[i]?.owner === ownerId) indices.push(i);
      }
      for (const i of indices) {
        const rec = extensions[i];
        if (!rec) continue;
        bus.emit('capability:removed', { capability: String(rec.capability), provider: rec.owner });
        delete extensionFields[rec.capability as string];
        caps.remove(rec.capability);
        extensions.splice(i, 1);
      }
    },
    dispose() { bus.destroy(); },
  };

  return { host, control };
}
