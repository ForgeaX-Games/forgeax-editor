// packages/interface/src/core/app-shell/types.ts
import type React from 'react';
import type { PluginManifest, Cleanup } from '../plugin-foundation';
import type { EventBus } from '../plugin-foundation/bus';
import type { CommandsRegistry, CommandDescriptor } from '../plugin-foundation/commands';
import type { ContextKeysApi } from '../plugin-foundation/context-keys';
import type { StorageApi } from '../plugin-foundation/storage';
import type { PanelRenderers } from '../../components/DockShell/panelRenderers';
import type { PillPayload } from '../../lib/composer-bridge';

export interface AppBusEventMap extends Record<string, unknown> {
  'panel:open':          { id: string; source?: string };
  'panel:focus':         { id: string };
  'panel:close':         { id: string };
  'dock:reset':          Record<string, never>;
  'dock:layout-toggle':  { workbenchId?: string; rect?: { top: number; bottom: number; left: number; right: number } };
  'anim:handoff':        { fromSurface: string; toSurface: string };
  'chat:pill':           { pill: PillPayload };
  'iframe:navigate':     { pluginId: string; url?: string };
  'capability:added':    { capability: string; provider: string };
  'capability:removed':  { capability: string; provider: string };
  // domain plugins may extend via .d.ts module augmentation
}

export type HostCapability =
  | 'commands' | 'bus' | 'storage' | 'panels' | 'contextKeys'
  | 'session' | 'workbench' | 'observability' | 'editor'
  | (string & {});

export interface AppLogger {
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}

export interface AppHostBase {
  readonly commands: CommandsRegistry;
  readonly bus: EventBus<AppBusEventMap>;
  readonly storage: StorageApi;
  readonly contextKeys: ContextKeysApi;
  readonly panels: PanelRenderers;
  readonly capabilities: ReadonlySet<HostCapability>;
  extend<K extends HostCapability>(capability: K, api: unknown): void;
}

/** Consumers narrow optional fields with `if (host.session) {...}`. */
export interface AppHost extends AppHostBase {
  readonly session?: unknown;                // typed by session-client plugin's .d.ts
  readonly workbench?: unknown;              // typed by workbench-client plugin's .d.ts
  readonly observability?: unknown;          // typed by observability plugin's .d.ts
  readonly editor?: unknown;
  readonly [extension: string]: unknown;
}

export interface AppPluginContext {
  readonly host: AppHost;
  readonly bus: EventBus<AppBusEventMap>;
  readonly storage: StorageApi;
  readonly log: AppLogger;
  registerCommand(cmd: CommandDescriptor): Cleanup;
  contributePanels(patch: Partial<PanelRenderers>): Cleanup;
}

export type AppPlugin = PluginManifest<HostCapability, AppPluginContext>;
