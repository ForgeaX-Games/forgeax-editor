// packages/interface/src/core/app-shell/host.ts
import {
  createCommandsRegistry, type CommandsRegistry,
} from '../extension-foundation/commands';
import { EventBus } from '../extension-foundation/bus';
import { createContextKeys, type ContextKeysApi } from '../extension-foundation/context-keys';
import { createStorageApi, type StorageApi } from '../extension-foundation/storage';
import { createCapabilityRegistry, type CapabilityRegistry } from '../extension-foundation/capabilities';
import { createContributionRegistry } from '../extension-foundation/contribution-registry';
import { ExtensionConflictError } from '../extension-foundation/errors';
import type { Cleanup } from '../extension-foundation/types';
import type {
  AppBusEventMap, AppHost, AppHostBase, AppLogger, AppExtension, HostCapability,
} from './types';
import { consoleLogger } from './logger';
import { derivePanelRenderers } from './derive-panel-renderers';
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
  beginSetup(manifest: AppExtension): void;
  endSetup(): void;
  removeExtensionsByOwner(ownerId: string): void;
  readonly capabilities: CapabilityRegistry<HostCapability>;
  /** ADR 0025 M2 — the contribution channel behind host.panels. Owner-tagged;
   *  the returned Cleanup removes exactly this batch (snapshot re-folds). */
  contributePanels(owner: string, patch: Partial<PanelRenderers>): Cleanup;
  /** Coarse change signal for the derived panels snapshot (React subscribes
   *  via useSyncExternalStore in App.tsx). */
  onPanelsChange(listener: () => void): () => void;
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
  // ADR 0025 M2: the ContributionRegistry is the SSOT; host.panels is a
  // memoized DERIVED snapshot (new identity per registry version — App.tsx
  // reads it through useSyncExternalStore, so post-boot contributions and
  // cleanups re-render the shell). deps.initialPanels joins as the host-owned
  // baseline contribution.
  const panelsRegistry = createContributionRegistry<Partial<PanelRenderers>>();
  if (deps.initialPanels) panelsRegistry.contribute('(host)', deps.initialPanels);
  let panelsCache: { v: number; snap: PanelRenderers } | null = null;
  const panelsSnapshot = (): PanelRenderers => {
    const v = panelsRegistry.version();
    if (panelsCache?.v === v) return panelsCache.snap;
    const snap = derivePanelRenderers(
      DEFAULT_PANEL_RENDERERS,
      panelsRegistry.entries().map((e) => e.item),
    );
    panelsCache = { v, snap };
    return snap;
  };

  const extensions: ExtensionRecord[] = [];
  const extensionFields: Record<string, unknown> = {};

  let activeSetup: AppExtension | null = null;

  const base: AppHostBase = {
    commands, bus, storage, contextKeys,
    get panels() { return panelsSnapshot(); },
    get capabilities() { return caps.snapshot(); },
    extend(capability, api) {
      if (activeSetup === null) {
        throw new Error(`[app-shell] host.extend("${String(capability)}") called outside plugin setup`);
      }
      if (!activeSetup.provides?.includes(capability)) {
        throw new ExtensionConflictError({
          id: String(capability), subRegistryName: 'host.extend',
          existingOwner: '(none)', newOwner: activeSetup.id,
        });
      }
      if (extensionFields[capability as string] !== undefined) {
        const orig = extensions.find((e) => e.capability === capability);
        throw new ExtensionConflictError({
          id: String(capability), subRegistryName: 'host.extend',
          existingOwner: orig?.owner ?? '(unknown)', newOwner: activeSetup.id,
        });
      }
      if (BUILT_IN_CAPS.includes(capability)) {
        throw new ExtensionConflictError({
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
    contributePanels(owner, patch) { return panelsRegistry.contribute(owner, patch); },
    onPanelsChange(listener) { return panelsRegistry.onChange(listener); },
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
