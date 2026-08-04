import type {
  PageCardinality,
  PageErrorCode,
  PageKey,
  PageLayoutEnvelope,
  QualifiedPageTypeId,
  QualifiedPanelTypeId,
  QualifiedActivityId,
  QualifiedResourceEditorId,
  ResourceDescriptor,
  ResourceSelector,
} from '@forgeax/types';
import type { SerializedDockview } from 'dockview';
import type { ReactNode } from 'react';

export interface PanelRenderContext {
  readonly pageKey: PageKey;
  readonly placementId: string;
  readonly pageContext: Readonly<Record<string, unknown>>;
  readonly initialProps?: Readonly<Record<string, unknown>>;
}

export type PanelRuntime =
  | { readonly kind: 'inline'; readonly render: (context: PanelRenderContext) => ReactNode }
  | { readonly kind: 'iframe'; readonly src: string };

export interface PanelTypeRegistration {
  readonly id: QualifiedPanelTypeId;
  readonly runtime: PanelRuntime;
}

export interface PagePanelPlacement {
  readonly id: string;
  readonly panelTypeId: QualifiedPanelTypeId;
  readonly title?: string;
  readonly optional?: boolean;
  readonly initialProps?: Readonly<Record<string, unknown>>;
}

export type PageCloseReason = 'user' | 'extension-disabled' | 'workspace-change' | 'host-dispose';
export type PageCloseDecision = 'save' | 'discard' | 'cancel';

export type PageClosePreparation =
  | { readonly status: 'ready' }
  | { readonly status: 'dirty'; readonly message?: string }
  | { readonly status: 'vetoed'; readonly message?: string };

export interface PageController {
  prepareClose(reason: PageCloseReason): PageClosePreparation | Promise<PageClosePreparation>;
  save?(): void | Promise<void>;
  discard?(): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface PageControllerContext {
  readonly key: PageKey;
  readonly context: Readonly<Record<string, unknown>>;
  readonly resource?: ResourceDescriptor;
}

export interface PageTypeRegistration {
  readonly id: QualifiedPageTypeId;
  readonly title: string;
  readonly cardinality: PageCardinality;
  readonly restorePolicy?: 'never' | 'session' | 'project';
  readonly closable?: boolean;
  readonly layoutVersion?: number;
  readonly layout: PageLayoutEnvelope | SerializedDockview;
  readonly panels: readonly PagePanelPlacement[];
  readonly createController?: (context: PageControllerContext) => PageController | Promise<PageController>;
}

export interface PagePlatformContribution {
  readonly pageTypes?: readonly PageTypeRegistration[];
  readonly panelTypes?: readonly PanelTypeRegistration[];
  readonly activities?: readonly ActivityRegistration[];
  readonly resourceEditors?: readonly ResourceEditorRegistration[];
}

export interface ActivityRegistration {
  readonly id: QualifiedActivityId;
  readonly title: string;
  readonly icon?: string;
  readonly category?: string;
  readonly order?: number;
  readonly pageTypeId?: QualifiedPageTypeId;
  readonly commandId?: string;
}

export interface ResourceEditorRegistration {
  readonly id: QualifiedResourceEditorId;
  readonly selector: ResourceSelector;
  readonly pageTypeId: QualifiedPageTypeId;
  readonly priority?: 'default' | 'optional';
  readonly sourceLayer?: 'builtin' | 'installed' | 'project' | 'user';
}

export interface ActivityRegistrySnapshot {
  readonly generation: number;
  readonly activities: readonly (ActivityRegistration & { readonly owner: string })[];
}

export interface ActivityRegistry {
  getSnapshot(): ActivityRegistrySnapshot;
  subscribe(listener: () => void): () => void;
  launch(id: QualifiedActivityId): Promise<void>;
}

export interface ResourceEditorResolver {
  list(resource: ResourceDescriptor): readonly ResourceEditorRegistration[];
  resolve(resource: ResourceDescriptor): ResourceEditorRegistration | undefined;
  open(resource: ResourceDescriptor): Promise<PageKey>;
  setUserAssociation(resource: ResourceDescriptor, editorId: QualifiedResourceEditorId | null): void;
}

export interface ResolvedPanelPlacement extends PagePanelPlacement {
  readonly panelType: PanelTypeRegistration;
}

export type ResolvedPageType =
  | {
      readonly status: 'available';
      readonly owner: string;
      readonly definition: PageTypeRegistration;
      readonly layout: PageLayoutEnvelope | SerializedDockview;
      readonly panels: readonly ResolvedPanelPlacement[];
    }
  | {
      readonly status: 'unavailable';
      readonly owner: string;
      readonly definition: PageTypeRegistration;
      readonly reason: 'missing-required-panel' | 'duplicate-page-type';
      readonly missingPanelTypeIds: readonly QualifiedPanelTypeId[];
    };

export interface PageRegistrySnapshot {
  readonly generation: number;
  readonly pageTypes: ReadonlyMap<QualifiedPageTypeId, ResolvedPageType>;
  readonly panelTypes: ReadonlyMap<QualifiedPanelTypeId, PanelTypeRegistration>;
}

export interface PageRegistry {
  get(typeId: QualifiedPageTypeId): ResolvedPageType | undefined;
  ownerOf(typeId: QualifiedPageTypeId): string | undefined;
  getSnapshot(): PageRegistrySnapshot;
  subscribe(listener: () => void): () => void;
  validateContribution(owner: string, contribution: PagePlatformContribution): void;
}

export interface PageOpenRequest {
  readonly typeId: QualifiedPageTypeId;
  readonly resource?: ResourceDescriptor;
  readonly instanceId?: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface PageCloseRequest {
  readonly reason?: PageCloseReason;
  readonly decision?: PageCloseDecision;
}

export interface PageInstance {
  readonly key: PageKey;
  readonly encodedKey: string;
  readonly typeId: QualifiedPageTypeId;
  readonly context: Readonly<Record<string, unknown>>;
  readonly resource?: ResourceDescriptor;
  readonly openedAt: number;
  readonly closable: boolean;
}

export interface PageSessionSnapshot {
  readonly generation: number;
  readonly activeKey?: string;
  readonly instances: readonly PageInstance[];
}

export interface PagePort {
  open(request: PageOpenRequest): Promise<PageKey>;
  focus(key: PageKey | string): Promise<void>;
  close(key: PageKey | string, request?: PageCloseRequest): Promise<void>;
  getSnapshot(): PageSessionSnapshot;
  subscribe(listener: () => void): () => void;
}

export type PagePlatformErrorCode = PageErrorCode;

export class PagePlatformError extends Error {
  readonly code: PagePlatformErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: PagePlatformErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'PagePlatformError';
    this.code = code;
    this.details = details;
  }
}
