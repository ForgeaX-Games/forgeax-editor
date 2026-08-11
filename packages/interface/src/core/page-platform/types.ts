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

/**
 * One right-click menu entry contributed by a page's controller. VSCode-style:
 * the controller AUTHORS the item (id/label/icon) and OWNS its behaviour
 * (`run`) and live state (`disabled`), re-evaluated each time the menu opens —
 * so e.g. a "Save" item can enable only while the page is dirty.
 */
export interface PageMenuItem {
  readonly id: string;
  readonly label: string;
  /** Lucide glyph name (kebab, e.g. "copy" / "folder-search"); the tab strip
   *  resolves it to a lucide-react icon — same glyph set as the design demo. */
  readonly icon?: string;
  /** Items sharing a group render contiguously; a divider separates groups (and
   *  the platform's base close group). */
  readonly group?: string;
  readonly disabled?: boolean;
  run(): void | Promise<void>;
}

export interface PageController {
  prepareClose(reason: PageCloseReason): PageClosePreparation | Promise<PageClosePreparation>;
  save?(): void | Promise<void>;
  discard?(): void | Promise<void>;
  dispose(): void | Promise<void>;
  /**
   * Contribute this page's right-click menu items (beyond the platform's base
   * close group), evaluated freshly on each open so `disabled`/`label` reflect
   * live state. VSCode `menus`-contribution analogue, owned per instance.
   */
  getContextMenuItems?(): readonly PageMenuItem[];
  /**
   * Live tab title, VSCode `EditorInput.getName()`-style. When present it
   * overrides the static page-type title in the tab strip — a resource-less
   * singleton (e.g. the level editor) has no other per-instance name. Return
   * `undefined` to fall back to the static title.
   */
  getTitle?(): string | undefined;
  /**
   * Subscribe to title changes, VSCode `onDidChangeLabel`-style. The session
   * re-reads `getTitle()` on each notification and republishes the snapshot, so
   * the tab updates event-driven with zero polling. Returns an unsubscribe fn.
   */
  subscribeTitle?(listener: () => void): () => void;
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

export interface ActivityLocalizedText {
  readonly zh?: string;
  readonly en?: string;
  readonly ja?: string;
}

export interface ActivityRegistration {
  readonly id: QualifiedActivityId;
  readonly title: string;
  /** Unresolved manifest text retained so shell chrome reacts to locale changes. */
  readonly titleI18n?: ActivityLocalizedText;
  /** Runtime-only localized extension description; not part of manifest contracts. */
  readonly description?: string;
  readonly descriptionI18n?: ActivityLocalizedText;
  readonly icon?: string;
  readonly category?: string;
  readonly order?: number;
  /**
   * Registration source, injected by the host at the assembly seam — NEVER
   * self-declared by an extension. It is the primary rail sort key: builtin
   * activities always precede installed/project ones, so an unranked plugin
   * can never jump ahead of the core nav. `order` only breaks ties WITHIN a
   * layer (VSCode `group@order` philosophy — the layer caps the reach of any
   * plugin's number). Absent ⇒ treated as `installed`.
   */
  readonly sourceLayer?: 'builtin' | 'installed' | 'project' | 'user';
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
  /**
   * Live tab title reflected from the page's controller (`getTitle()` +
   * `subscribeTitle()`), e.g. the level editor tracking the current scene name.
   * Overrides the static page-type title in the tab strip.
   */
  readonly title?: string;
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
  /**
   * Move an open page to a new position in the tab order. Tab order is session
   * state (the insertion order of live instances), so reordering lives here —
   * the SSOT — rather than as UI-local state that would drift from the snapshot.
   * `toIndex` is clamped to the valid range; a no-op move publishes nothing.
   */
  reorder(key: PageKey | string, toIndex: number): void;
  /**
   * The right-click menu items contributed by an open page's controller,
   * evaluated now (fresh live state). Empty when the page has no controller
   * items — the tab strip always prepends its own base close group.
   */
  getContextMenuItems(key: PageKey | string): readonly PageMenuItem[];
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
