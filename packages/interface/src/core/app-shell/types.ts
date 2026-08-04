// packages/interface/src/core/app-shell/types.ts
import type React from 'react';
import type { ExtensionManifest, Cleanup } from '../extension-foundation';
import type { EventBus } from '../extension-foundation/bus';
import type { CommandsRegistry, CommandDescriptor } from '../extension-foundation/commands';
import type { ContextKeysApi } from '../extension-foundation/context-keys';
import type { StorageApi } from '../extension-foundation/storage';
import type { PanelRenderers } from '../../components/DockShell/panelRenderers';
import type { PanelActionContribution, PanelActionsApi, PanelControlContribution, PanelControlsApi, StatusItemContribution } from '../panels';
import type {
  PagePlatformContribution,
  PagePort,
  PageRegistry,
  PageTypeRegistration,
  PanelTypeRegistration,
  ActivityRegistration,
  ResourceEditorRegistration,
  ActivityRegistry,
  ResourceEditorResolver,
} from '../page-platform';

export type AppShellPillKind =
  | 'file' | 'dir' | 'agent' | 'tool' | 'game' | 'log' | 'entity' | 'paste'
  | 'skill' | 'command';

export interface AppShellPillPayload {
  kind: AppShellPillKind;
  display: string;
  icon?: string;
  detail: string;
  tooltip: { title: string; lines: string[] };
}

export interface AppBusEventMap extends Record<string, unknown> {
  'panel:open':          { id: string; source?: string };
  'panel:focus':         { id: string };
  'panel:close':         { id: string };
  'dock:reset':          Record<string, never>;
  'dock:layout-toggle':  { workbenchId?: string; rect?: { top: number; bottom: number; left: number; right: number } };
  'anim:handoff':        { fromSurface: string; toSurface: string };
  'chat:pill':           { pill: AppShellPillPayload };
  'iframe:navigate':     { extensionId: string; url?: string };
  'capability:added':    { capability: string; provider: string };
  'capability:removed':  { capability: string; provider: string };
  // domain plugins may extend via .d.ts module augmentation
}

export type HostCapability =
  | 'commands' | 'bus' | 'storage' | 'panels' | 'panelActions' | 'panelControls' | 'contextKeys' | 'pages'
  | 'activities' | 'resourceEditors'
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
  readonly panelActions: PanelActionsApi;
  readonly panelControls: PanelControlsApi;
  readonly pages: PagePort;
  readonly pageRegistry: PageRegistry;
  readonly activities: ActivityRegistry;
  readonly resourceEditors: ResourceEditorResolver;
  readonly capabilities: ReadonlySet<HostCapability>;
  extend<K extends HostCapability>(capability: K, api: unknown): void;
  /** ADR-0030 §2.2 — imperative, RUNTIME status-item registration. The
   *  single-truth successor to the retired module-level statusBarStore: writes
   *  through the same panels contribution registry (host.panels.stripItems),
   *  so it is owner-neutral yet reversible via the returned Cleanup. Use for
   *  chips whose existence is decided at runtime; boot-time-known chips should
   *  prefer declarative `contributes.panels.stripItems`. */
  contributeStatusItem(item: StatusItemContribution): Cleanup;
}

/** Consumers narrow optional fields with `if (host.session) {...}`. */
export interface AppHost extends AppHostBase {
  readonly session?: unknown;                // typed by session-client plugin's .d.ts
  readonly workbench?: unknown;              // typed by workbench-client plugin's .d.ts
  readonly observability?: unknown;          // typed by observability plugin's .d.ts
  readonly editor?: unknown;
  readonly [extension: string]: unknown;
}

export interface AppExtensionContext {
  readonly host: AppHost;
  readonly bus: EventBus<AppBusEventMap>;
  readonly storage: StorageApi;
  readonly log: AppLogger;
  registerCommand(cmd: CommandDescriptor): Cleanup;
  contributePanels(patch: Partial<PanelRenderers>): Cleanup;
  contributePanelActions(actions: readonly PanelActionContribution[]): Cleanup;
  contributePanelControls(controls: readonly PanelControlContribution[]): Cleanup;
  contributePagePlatform(contribution: PagePlatformContribution): Cleanup;
}

/** ADR 0025 M2 — declarative contributions. Applied by the bootstrap glue
 *  before setup() runs and removed with the extension's cleanup; a pure-UI
 *  extension is just data (no setup at all). */
export interface AppExtensionContributes {
  readonly panels?: Partial<PanelRenderers>;
  readonly panelActions?: readonly PanelActionContribution[];
  readonly panelControls?: readonly PanelControlContribution[];
  readonly pages?: readonly PageTypeRegistration[];
  readonly panelTypes?: readonly PanelTypeRegistration[];
  readonly activities?: readonly ActivityRegistration[];
  readonly resourceEditors?: readonly ResourceEditorRegistration[];
}

/** An app-shell extension manifest. Unlike the domain-agnostic
 *  ExtensionManifest, `setup` is OPTIONAL here — contributes-only extensions
 *  need no imperative code; the bootstrap wrap supplies the loader-required
 *  setup shim (see appHostBootstrap.ts). */
export type AppExtension =
  Omit<ExtensionManifest<HostCapability, AppExtensionContext>, 'setup'> & {
    readonly setup?: ExtensionManifest<HostCapability, AppExtensionContext>['setup'];
    readonly contributes?: AppExtensionContributes;
  };
