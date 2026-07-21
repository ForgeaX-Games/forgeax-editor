import type { Cleanup } from '../extension-foundation/types';
import type { ReactNode } from 'react';

export type PanelActionLocation =
  | 'header/left'
  | 'header/center'
  | 'header/right'
  | 'context';

export type PanelActionContribution =
  | PanelCommandActionContribution
  | PanelMenuActionContribution
  | PanelControlActionContribution;

export interface PanelCommandActionContribution {
  readonly kind?: 'command';
  readonly id: string;
  readonly panelId: string;
  readonly command: string;
  readonly title: string;
  readonly label?: string;
  readonly icon?: string;
  readonly order?: number;
  readonly location?: PanelActionLocation;
  readonly group?: string;
  readonly when?: string;
  readonly enablement?: string;
  readonly activeWhen?: string;
  readonly highlightWhen?: string;
  readonly args?: unknown;
}

export interface PanelMenuActionContribution {
  readonly kind: 'menu';
  readonly id: string;
  readonly panelId: string;
  readonly title: string;
  readonly label?: string;
  readonly labelContextKey?: string;
  readonly icon?: string;
  readonly order?: number;
  readonly location?: Exclude<PanelActionLocation, 'context'>;
  readonly group?: string;
  readonly when?: string;
  readonly enablement?: string;
  readonly activeWhen?: string;
  readonly highlightWhen?: string;
  readonly items: readonly PanelMenuItemContribution[];
  readonly itemsContextKey?: string;
}

export interface PanelControlActionContribution {
  readonly kind: 'control';
  readonly id: string;
  readonly panelId: string;
  readonly control: string;
  readonly order?: number;
  readonly location?: Exclude<PanelActionLocation, 'context'>;
  readonly group?: string;
  readonly when?: string;
  readonly enablement?: string;
}

export type PanelMenuItemContribution =
  | PanelCommandMenuItemContribution
  | PanelSeparatorMenuItemContribution;

export interface PanelCommandMenuItemContribution {
  readonly kind?: 'command';
  readonly id: string;
  readonly command: string;
  readonly title: string;
  readonly icon?: string;
  readonly checkable?: boolean;
  readonly tone?: 'default' | 'reset';
  readonly order?: number;
  readonly when?: string;
  readonly enablement?: string;
  readonly activeWhen?: string;
  readonly highlightWhen?: string;
  readonly args?: unknown;
}

export interface PanelSeparatorMenuItemContribution {
  readonly kind: 'separator';
  readonly id: string;
  readonly order?: number;
  readonly when?: string;
}

export interface PanelActionInvokeContext {
  readonly panelId: string;
  readonly actionId: string;
  readonly source: 'panel-header' | 'panel-context-menu';
  readonly args?: unknown;
}

export interface ResolvedPanelActionState {
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly highlighted: boolean;
}

export interface PanelActionsApi {
  contribute(owner: string, actions: readonly PanelActionContribution[]): Cleanup;
  list(panelId: string): readonly PanelActionContribution[];
  all(): readonly PanelActionContribution[];
  onChange(listener: () => void): Cleanup;
  version(): number;
}

export interface PanelControlRenderContext {
  readonly panelId: string;
  readonly actionId: string;
}

export interface PanelControlContribution {
  readonly id: string;
  readonly render: (ctx: PanelControlRenderContext) => ReactNode;
}

export interface PanelControlsApi {
  contribute(owner: string, controls: readonly PanelControlContribution[]): Cleanup;
  get(id: string): PanelControlContribution | undefined;
  list(): readonly PanelControlContribution[];
  onChange(listener: () => void): Cleanup;
  version(): number;
}

export interface PanelHeaderDefinition {
  readonly visible?: boolean;
  readonly showTitle?: boolean;
  readonly subtitle?: string;
  readonly badges?: readonly PanelBadgeDefinition[];
}

export interface PanelContentDefinition {
  readonly padding?: 'none' | 'sm' | 'md';
  readonly scroll?: 'none' | 'auto';
  readonly tone?: 'default' | 'surface' | 'tool';
}

export interface PanelBadgeDefinition {
  readonly id: string;
  readonly label: string;
  readonly tone?: 'neutral' | 'info' | 'warning' | 'danger' | 'success';
  readonly when?: string;
}
