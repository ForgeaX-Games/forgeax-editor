import { z } from 'zod';
import { ExtensionIdSchema } from './extension-id';
import { I18nStringSchema } from './i18n';

/** Manifest-local contribution ids. Qualified ids are derived by the host. */
export const LocalContributionIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9.-]*$/u, {
    message: 'contribution id must start with a lowercase letter and contain only lowercase letters, numbers, dots, and hyphens',
  });

export const ContributionKindSchema = z.enum(['page', 'panel', 'activity', 'resource-editor']);
export type ContributionKind = z.infer<typeof ContributionKindSchema>;

const QUALIFIED_ID_PATTERN = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9_][a-z0-9-_]*#(page|panel|activity|resource-editor)\/([a-z][a-z0-9.-]*)$/u;

export const QualifiedContributionIdSchema = z.string().regex(QUALIFIED_ID_PATTERN, {
  message: 'qualified contribution id must be `@scope/name#kind/local-id`',
});

export const QualifiedPageTypeIdSchema = z.string().regex(
  /^@[a-z0-9][a-z0-9-]*\/[a-z0-9_][a-z0-9-_]*#page\/([a-z][a-z0-9.-]*)$/u,
);
export const QualifiedPanelTypeIdSchema = z.string().regex(
  /^@[a-z0-9][a-z0-9-]*\/[a-z0-9_][a-z0-9-_]*#panel\/([a-z][a-z0-9.-]*)$/u,
);
export const QualifiedActivityIdSchema = z.string().regex(
  /^@[a-z0-9][a-z0-9-]*\/[a-z0-9_][a-z0-9-_]*#activity\/([a-z][a-z0-9.-]*)$/u,
);
export const QualifiedResourceEditorIdSchema = z.string().regex(
  /^@[a-z0-9][a-z0-9-]*\/[a-z0-9_][a-z0-9-_]*#resource-editor\/([a-z][a-z0-9.-]*)$/u,
);

export type QualifiedContributionId = z.infer<typeof QualifiedContributionIdSchema>;
export type QualifiedPageTypeId = z.infer<typeof QualifiedPageTypeIdSchema>;
export type QualifiedPanelTypeId = z.infer<typeof QualifiedPanelTypeIdSchema>;
export type QualifiedActivityId = z.infer<typeof QualifiedActivityIdSchema>;
export type QualifiedResourceEditorId = z.infer<typeof QualifiedResourceEditorIdSchema>;

export function qualifyContributionId(
  extensionId: string,
  kind: ContributionKind,
  localId: string,
): QualifiedContributionId {
  ExtensionIdSchema.parse(extensionId);
  ContributionKindSchema.parse(kind);
  LocalContributionIdSchema.parse(localId);
  return QualifiedContributionIdSchema.parse(`${extensionId}#${kind}/${localId}`);
}

export const ContributionRefSchema = z.union([
  z
    .object({
      extension: z.literal('self'),
      id: LocalContributionIdSchema,
    })
    .strict(),
  z
    .object({
      extension: ExtensionIdSchema,
      id: LocalContributionIdSchema,
      version: z.string().min(1).optional(),
    })
    .strict(),
]);

export type ContributionRef = z.infer<typeof ContributionRefSchema>;

export function resolveContributionRef(
  ownerExtensionId: string,
  kind: ContributionKind,
  ref: ContributionRef,
): QualifiedContributionId {
  const parsed = ContributionRefSchema.parse(ref);
  const extensionId = parsed.extension === 'self' ? ownerExtensionId : parsed.extension;
  return qualifyContributionId(extensionId, kind, parsed.id);
}

export const PageCardinalitySchema = z.enum(['singleton', 'resource', 'multi-instance']);
export type PageCardinality = z.infer<typeof PageCardinalitySchema>;

export const PageLayoutNodeSchema: z.ZodType<PageLayoutNode> = z.lazy(() =>
  z.union([
    z
      .object({
        kind: z.literal('split'),
        direction: z.enum(['horizontal', 'vertical']),
        sizes: z.array(z.number().positive()).optional(),
        children: z.array(PageLayoutNodeSchema).min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal('tabs'),
        placements: z.array(LocalContributionIdSchema),
        active: LocalContributionIdSchema.optional(),
      })
      .strict(),
  ]),
);

export type PageLayoutNode =
  | {
      kind: 'split';
      direction: 'horizontal' | 'vertical';
      sizes?: number[];
      children: PageLayoutNode[];
    }
  | {
      kind: 'tabs';
      placements: string[];
      active?: string;
    };

export const PageLayoutEnvelopeSchema = z
  .object({
    version: z.number().int().nonnegative(),
    root: PageLayoutNodeSchema,
  })
  .strict();

export type PageLayoutEnvelope = z.infer<typeof PageLayoutEnvelopeSchema>;

export const PanelPlacementContributionSchema = z
  .object({
    id: LocalContributionIdSchema,
    panelType: ContributionRefSchema,
    title: I18nStringSchema.optional(),
    optional: z.boolean().optional(),
    initialProps: z.record(z.unknown()).optional(),
  })
  .strict();

export const PageTypeContributionSchema = z
  .object({
    id: LocalContributionIdSchema,
    title: I18nStringSchema,
    icon: z.string().min(1).optional(),
    cardinality: PageCardinalitySchema,
    restorePolicy: z.enum(['never', 'session', 'project']).optional(),
    layout: z.string().min(1),
    layoutVersion: z.number().int().nonnegative(),
    panels: z.array(PanelPlacementContributionSchema).optional(),
  })
  .strict();

export const PanelTypeContributionSchema = z
  .object({
    id: LocalContributionIdSchema,
    title: I18nStringSchema.optional(),
    runtime: z.enum(['inline', 'iframe']),
    entry: z.string().min(1),
  })
  .strict();

export const ActivityContributionSchema = z
  .object({
    id: LocalContributionIdSchema,
    title: I18nStringSchema,
    icon: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    order: z.number().optional(),
    pageType: ContributionRefSchema.optional(),
    commandId: z.string().min(1).optional(),
  })
  .strict()
  .refine((activity) => Number(Boolean(activity.pageType)) + Number(Boolean(activity.commandId)) === 1, {
    message: 'activity must declare exactly one of pageType or commandId',
  });

export const ResourceSelectorSchema = z
  .object({
    schemes: z.array(z.string().min(1)).optional(),
    extensions: z.array(z.string().min(1)).optional(),
    mimeTypes: z.array(z.string().min(1)).optional(),
    kinds: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine((selector) => Boolean(
    selector.schemes?.length || selector.extensions?.length || selector.mimeTypes?.length || selector.kinds?.length,
  ), {
    message: 'resource selector must declare at least one scheme, extension, mime type, or kind',
  });

export const ResourceEditorContributionSchema = z
  .object({
    id: LocalContributionIdSchema,
    selector: ResourceSelectorSchema,
    pageType: ContributionRefSchema,
    priority: z.enum(['default', 'optional']).optional(),
  })
  .strict();

/** UI contribution family composed into the versioned extension manifest. */
export const PageContributionsSchema = z
  .object({
    pages: z.array(PageTypeContributionSchema).optional(),
    panelTypes: z.array(PanelTypeContributionSchema).optional(),
    activities: z.array(ActivityContributionSchema).optional(),
    resourceEditors: z.array(ResourceEditorContributionSchema).optional(),
  })
  .strict();

export type PanelPlacementContribution = z.infer<typeof PanelPlacementContributionSchema>;
export type PageTypeContribution = z.infer<typeof PageTypeContributionSchema>;
export type PanelTypeContribution = z.infer<typeof PanelTypeContributionSchema>;
export type ActivityContribution = z.infer<typeof ActivityContributionSchema>;
export type ResourceSelector = z.infer<typeof ResourceSelectorSchema>;
export type ResourceEditorContribution = z.infer<typeof ResourceEditorContributionSchema>;
export type PageContributions = z.infer<typeof PageContributionsSchema>;

export const ResourceDescriptorSchema = z
  .object({
    canonicalId: z.string().min(1),
    uri: z.string().min(1),
    displayPath: z.string().min(1).optional(),
    mime: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    revision: z.string().min(1).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export type ResourceDescriptor = z.infer<typeof ResourceDescriptorSchema>;

export const PageOpenRequestSchema = z
  .object({
    typeId: QualifiedPageTypeIdSchema,
    resource: ResourceDescriptorSchema.optional(),
    instanceId: z.string().min(1).optional(),
    context: z.record(z.unknown()).optional(),
  })
  .strict();

export type PageOpenRequestContract = z.infer<typeof PageOpenRequestSchema>;

export const PageErrorCodeSchema = z.enum([
  'PAGE_TYPE_NOT_FOUND',
  'PAGE_TYPE_UNAVAILABLE',
  'PAGE_CARDINALITY_MISMATCH',
  'PAGE_INSTANCE_NOT_FOUND',
  'PAGE_CLOSE_REQUIRES_DECISION',
  'PAGE_CLOSE_VETOED',
  'PAGE_CONTRIBUTION_CONFLICT',
  'PAGE_CONTRIBUTION_OWNER_MISMATCH',
  'RESOURCE_EDITOR_NOT_FOUND',
]);

export type PageErrorCode = z.infer<typeof PageErrorCodeSchema>;

export const PageKeySchema = z.discriminatedUnion('cardinality', [
  z
    .object({
      cardinality: z.literal('singleton'),
      typeId: QualifiedPageTypeIdSchema,
    })
    .strict(),
  z
    .object({
      cardinality: z.literal('resource'),
      typeId: QualifiedPageTypeIdSchema,
      resourceId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      cardinality: z.literal('multi-instance'),
      typeId: QualifiedPageTypeIdSchema,
      instanceId: z.string().min(1),
    })
    .strict(),
]);

export type PageKey = z.infer<typeof PageKeySchema>;

const PAGE_KEY_PREFIX = 'page:v1';

export function encodePageKey(key: PageKey): string {
  const parsed = PageKeySchema.parse(key);
  const typeId = encodeURIComponent(parsed.typeId);
  switch (parsed.cardinality) {
    case 'singleton':
      return `${PAGE_KEY_PREFIX}:s:${typeId}`;
    case 'resource':
      return `${PAGE_KEY_PREFIX}:r:${typeId}:${encodeURIComponent(parsed.resourceId)}`;
    case 'multi-instance':
      return `${PAGE_KEY_PREFIX}:m:${typeId}:${encodeURIComponent(parsed.instanceId)}`;
  }
}

export function decodePageKey(encoded: string): PageKey {
  const parts = encoded.split(':');
  if (parts[0] !== 'page' || parts[1] !== 'v1') {
    throw new Error(`unsupported page key: ${encoded}`);
  }

  try {
    if (parts[2] === 's' && parts.length === 4) {
      return PageKeySchema.parse({ cardinality: 'singleton', typeId: decodeURIComponent(parts[3]!) });
    }
    if (parts[2] === 'r' && parts.length === 5) {
      return PageKeySchema.parse({
        cardinality: 'resource',
        typeId: decodeURIComponent(parts[3]!),
        resourceId: decodeURIComponent(parts[4]!),
      });
    }
    if (parts[2] === 'm' && parts.length === 5) {
      return PageKeySchema.parse({
        cardinality: 'multi-instance',
        typeId: decodeURIComponent(parts[3]!),
        instanceId: decodeURIComponent(parts[4]!),
      });
    }
  } catch (error) {
    throw new Error(`invalid page key: ${encoded}`, { cause: error });
  }

  throw new Error(`invalid page key: ${encoded}`);
}
