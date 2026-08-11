/**
 * forgeax-extension.json zod schema — single source of truth.
 *
 * 见 docs/v2-vision/architecture-evolution/03-AGENT-SKILL-PLUGIN-TRINITY.md §3
 * 「三体 manifest 合法组合 + R1/R2/R3 规则」。
 *
 * R1（ADR 0025 M4 修订）: 每个 extension 只有一个主 kind。kind=workbench 可带
 *     skills/tools，且可附带 **provides.agents[]**（同一扩展同时贡献前端 UI 与
 *     server 侧 agent —— ADR 0025 D1-D5 §2「一份 manifest，多个 host 各取所需」，
 *     wb-reel 全家合并的依据）；kind=agent 仍是单数 provides.agent，不得带 workbench。
 *     Discriminated union by `kind` 强制主 kind 唯一。
 * R2: provides.skills[] 在不同 host 里语义不同（全局 / agent-default / workbench-bound）
 *     —— loader 行为，schema 只校验形状。
 * R3: 跨 extension SkillRef 用 `@scope/name#skillId`（在 src/skill.ts 落 SkillRefSchema）。
 *
 * 这个 schema 必须接受 packages/marketplace/extensions/ 下全部真实 manifest（验收
 * 标准见 13-MIGRATION-ROADMAP §A1）。test/validate-manifests.ts 跑回归。
 */
import { z } from 'zod';
import { I18nStringSchema } from './i18n';
import { ExtensionIdSchema, SemverLikeSchema } from './extension-id';
import { PageContributionsSchema } from './page';
import { ManifestSkillEntrySchema } from './skill';
import { ManifestToolEntrySchema } from './tool';
import {
  ManifestCommandCapabilitySchema,
  ManifestMcpCapabilitySchema,
  ManifestMemoryCapabilitySchema,
} from './capability';

/* ============================================================================
 * Common building blocks
 * ==========================================================================*/

// 第二段起始字符允许 `_`，用于约定俗成的 `_template` / `_archive` 等隐藏样板。
export { ExtensionIdSchema, SemverLikeSchema } from './extension-id';

const AuthorSchema = z.object({
  name: z.string().min(1),
  email: z.string().optional(),
  url: z.string().optional(),
});

const DependencySchema = z.object({
  id: ExtensionIdSchema,
  versionRange: z.string().optional(),
  optional: z.boolean().optional(),
});

/** Permission scope 字符串 —— 详见 03 §6 + 10 §签名/install flow。
 *  目前仍由 loader 自己解析；schema 只断言非空字符串。 */
const PermissionScopeSchema = z.string().min(1);

const EventDeclSchema = z.object({
  name: z.string().min(1),
  payload: z.union([z.string().min(1), z.unknown()]).optional(),
});

const ConsumesSchema = z
  .object({
    models: z
      .array(
        z.object({
          channel: z.string().min(1),
          role: z.string().min(1),
        }),
      )
      .optional(),
  })
  .optional();

/* ============================================================================
 * provides.{...} kind-specific shapes
 * ==========================================================================*/

const PaneSchema = z.object({
  width: z.number().optional(),
  defaultWidth: z.number().optional(),
  minWidth: z.number().optional(),
  minHeight: z.number().optional(),
  collapsible: z.boolean().optional(),
  scrollable: z.boolean().optional(),
});

const ProvidesWorkbenchSchema = z.object({
  id: z.string().min(1),
  lens: z.string().optional(),
  icon: z.string().optional(),
  category: z.enum(['3D', '2D', 'general']).optional(),
  position: z.number().optional(),
  panelSize: z.enum(['sm', 'md', 'lg']).optional(),
  // Dock tab chrome hint for a single-tab group. 'hideTitle' collapses the tab
  // strip (chat / viewport style); the interface manifest adapter maps this to
  // PanelDescriptor.dockChrome.singleTab. It is only the DEFAULT — a user can
  // still reveal the title via the tab context menu (explicit override wins).
  singleTab: z.enum(['default', 'full', 'hideTitle']).optional(),
  surface: z.string().optional(), // "split" 等
  panes: z
    .object({
      left: PaneSchema.optional(),
      center: PaneSchema.optional(),
    })
    .optional(),
  bus: z.object({ surfaceId: z.string().min(1) }).optional(),
  matchProduces: z.array(z.string()).optional(),
  hidden: z.boolean().optional(),
  // Soft hint: when this workbench extension is active, the workbench panel's
  // upper-right agent picker defaults to this agent (a sub-agent panel under
  // the current session). Does NOT lock the user — they can still pick any
  // session agent from the dropdown. Accepts an agent id (`reia`, matching a
  // provides.agents[] entry of this or another extension) or an agent-kind
  // extension id (`@scope/agent-x`) — the picker strips the prefix either way.
  preferredAgent: z.string().min(1).optional(),
});

const ProvidesAgentSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  card: z.object({
    name: I18nStringSchema,
    // 统一命名「中文职能·英文名」+ 灰字英文职能。cnTitle=中文职能，enTitle=英文职能。
    cnTitle: z.string().min(1).optional(),
    enTitle: z.string().min(1).optional(),
    color: z.string().min(1),
    avatar: z.string().min(1),
    // ADR-0019: WEBM 状态机头像. 缺省时 loader 也会自动尝试 ./avatar/AVATAR.md.
    avatarSet: z
      .object({
        rulesFile: z.string().min(1).optional(),
      })
      .optional(),
  }),
  personaFile: z.string().min(1),
  memoryDir: z.string().optional(),
  produces: z.array(z.string()).optional(),
  preferredCliProvider: z.string().optional(),
  defaultLang: z.enum(['zh', 'en']).optional(),
  multiInstance: z.boolean().optional(),
  // defaultSkills 用 SkillRefSchema 严格校验，但允许缺省
  defaultSkills: z.array(z.unknown()).optional(),
  // Host 工具白名单 glob（如 ["narrative:*"]）；host-tools 桥据此把 exposedToAI
  // 的宿主工具注入此 agent 的对话工具清单。缺省 = 不注入（opt-in）。
  tools: z.array(z.string()).optional(),
});

const ProvidesCliProviderSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  models: z.array(z.string()).optional(),
  capabilities: z
    .object({
      streaming: z.boolean().optional(),
      thinking: z.boolean().optional(),
      toolCalls: z.boolean().optional(),
      subAgents: z.boolean().optional(),
      sessions: z.boolean().optional(),
    })
    .optional(),
  runner: z
    .object({
      cmd: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
    })
    .optional(),
});

const ProvidesModelBindingSchema = z.object({
  channel: z.string().min(1),
  vendor: z.string().min(1),
  models: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
});

/** DUAL-MODALITY-UI sec 4.2 - declarative surface registration.
 *  Each surface declares one or more actions; loaders auto-register them
 *  with the bus.ui registry at plugin load. `requireConfirm` reuses the
 *  3-value enum from ManifestToolEntry. `exposedToAI=false` keeps a surface
 *  out of `bus.tools.list` (e.g. internal selection state). */
const SurfaceActionSchema = z.object({
  id: z.string().min(1),
  exposedToAI: z.boolean().optional(),
  permission: PermissionScopeSchema.optional(),
  requireConfirm: z.enum(['always', 'destructive', 'never']).optional(),
});

const ProvidesSurfaceSchema = z.object({
  id: z.string().min(1),
  schema: z.string().optional(),
  actions: z.array(SurfaceActionSchema).optional(),
});

const ProvidesSharedCapabilitiesSchema = {
  commands: z.array(ManifestCommandCapabilitySchema).optional(),
  mcp: z.array(ManifestMcpCapabilitySchema).optional(),
  memory: z.array(ManifestMemoryCapabilitySchema).optional(),
};

/* ============================================================================
 * Entry points
 * ==========================================================================*/

const EntrySchema = z.object({
  backend: z.string().optional(),
  frontend: z.string().optional(),
  standalone: z
    .object({
      start: z.string().optional(),
      port: z.number().optional(),
      readyProbe: z.string().optional(),
      dev: z
        .object({
          watch: z.boolean().optional(),
          hmr: z.boolean().optional(),
        })
        .optional(),
      embeddedAlso: z.boolean().optional(),
      /** Doc 14 §4 spike — dev-only standalone entry. When true, the host
       *  refuses to load this entry under FORGEAX_NODE_ENV=production. Lets
       *  authors ship a `bun --watch dev.ts` shim without it leaking into
       *  packaged builds. */
      devOnly: z.boolean().optional(),
    })
    .optional(),
});

/* ============================================================================
 * Common base — fields every kind shares
 * ==========================================================================*/

const ManifestBase = {
  schemaVersion: z.literal(1),
  id: ExtensionIdSchema,
  version: SemverLikeSchema,
  displayName: I18nStringSchema,
  description: I18nStringSchema.optional(),
  author: AuthorSchema.optional(),
  icon: z.string().optional(),
  hidden: z.boolean().optional(),
  keywords: z.array(z.string()).optional(),
  dependencies: z.array(DependencySchema).optional(),
  consumes: ConsumesSchema,
  entry: EntrySchema.optional(),
  permissions: z.array(PermissionScopeSchema).optional(),
  hot: z.boolean().optional(),
  experimental: z.boolean().optional(),
  compatibleWith: z.record(z.string()).optional(),
  /** GAP 5 — plugin declares which host env vars it needs.
   *  Tool handlers receive only these keys via ctx.env (any other key is
   *  scrubbed). Default empty → no env exposed. Extensions authored against
   *  the host SDK MUST list keys here instead of reading process.env
   *  directly. */
  requestedEnv: z.array(z.string().min(1)).optional(),
};

/* ============================================================================
 * Discriminated union by `kind` — enforces R1.
 * ==========================================================================*/

export const ManifestKindSchema = z.enum([
  'agent',
  'skill',
  'workbench',
  'cli-provider',
  'model-binding',
  'tool',
]);

export type ManifestKind = z.infer<typeof ManifestKindSchema>;

/** kind=workbench: 必含 provides.workbench；可含 skills/tools/events；R1（M4 修订）
 *  可附带 agents[] —— 一份 manifest 同时贡献 UI（前端 host）与 agent 人格
 *  （server host），每个条目与 kind=agent 的单数 provides.agent 同 shape，
 *  personaFile 等相对路径以扩展根目录解析。禁带 cliProvider/modelBinding。 */
export const WorkbenchManifestSchema = z.object({
  ...ManifestBase,
  kind: z.literal('workbench'),
  provides: z
    .object({
      workbench: ProvidesWorkbenchSchema,
      agents: z.array(ProvidesAgentSchema).optional(),
      skills: z.array(ManifestSkillEntrySchema).optional(),
      tools: z.array(ManifestToolEntrySchema).optional(),
      events: z.array(EventDeclSchema).optional(),
      surfaces: z.array(ProvidesSurfaceSchema).optional(),
      ...ProvidesSharedCapabilitiesSchema,
    })
    .strict(),
});

/** kind=agent: 必含 provides.agent；可带 skills/tools；R1 禁带 workbench/cliProvider/modelBinding */
export const AgentManifestSchema = z.object({
  ...ManifestBase,
  kind: z.literal('agent'),
  provides: z
    .object({
      agent: ProvidesAgentSchema,
      skills: z.array(ManifestSkillEntrySchema).optional(),
      tools: z.array(ManifestToolEntrySchema).optional(),
      events: z.array(EventDeclSchema).optional(),
      surfaces: z.array(ProvidesSurfaceSchema).optional(),
      ...ProvidesSharedCapabilitiesSchema,
    })
    .strict(),
});

/** kind=skill: 必含 provides.skills (>=1)。skill plugin 也可带自己的 tools。 */
export const SkillManifestSchema = z.object({
  ...ManifestBase,
  kind: z.literal('skill'),
  provides: z
    .object({
      skills: z.array(ManifestSkillEntrySchema).min(1),
      tools: z.array(ManifestToolEntrySchema).optional(),
      events: z.array(EventDeclSchema).optional(),
      surfaces: z.array(ProvidesSurfaceSchema).optional(),
      ...ProvidesSharedCapabilitiesSchema,
    })
    .strict(),
});

/** kind=cli-provider */
export const CliProviderManifestSchema = z.object({
  ...ManifestBase,
  kind: z.literal('cli-provider'),
  provides: z
    .object({
      cliProvider: ProvidesCliProviderSchema,
    })
    .strict(),
});

/** kind=model-binding */
export const ModelBindingManifestSchema = z.object({
  ...ManifestBase,
  kind: z.literal('model-binding'),
  provides: z
    .object({
      modelBinding: ProvidesModelBindingSchema,
    })
    .strict(),
});

/** kind=tool: 必含 provides.tools (>=1) */
export const ToolManifestSchema = z.object({
  ...ManifestBase,
  kind: z.literal('tool'),
  provides: z
    .object({
      tools: z.array(ManifestToolEntrySchema).min(1),
      events: z.array(EventDeclSchema).optional(),
      surfaces: z.array(ProvidesSurfaceSchema).optional(),
      ...ProvidesSharedCapabilitiesSchema,
    })
    .strict(),
});

/** 顶层 union — 按 kind 分发 */
export const ManifestSchema = z.discriminatedUnion('kind', [
  WorkbenchManifestSchema,
  AgentManifestSchema,
  SkillManifestSchema,
  CliProviderManifestSchema,
  ModelBindingManifestSchema,
  ToolManifestSchema,
]);

/**
 * Manifest v2 is capability-shaped: packaging categories never gate which
 * contribution families an extension may publish.
 */
export const ManifestV2ContributionsSchema = PageContributionsSchema.extend({
  agents: z.array(ProvidesAgentSchema).optional(),
  skills: z.array(ManifestSkillEntrySchema).optional(),
  tools: z.array(ManifestToolEntrySchema).optional(),
  events: z.array(EventDeclSchema).optional(),
  surfaces: z.array(ProvidesSurfaceSchema).optional(),
  commands: z.array(ManifestCommandCapabilitySchema).optional(),
  mcp: z.array(ManifestMcpCapabilitySchema).optional(),
  memory: z.array(ManifestMemoryCapabilitySchema).optional(),
  cliProviders: z.array(ProvidesCliProviderSchema).optional(),
  modelBindings: z.array(ProvidesModelBindingSchema).optional(),
});

export const ManifestV2Schema = z.object({
  ...ManifestBase,
  schemaVersion: z.literal(2),
  categories: z.array(z.string().min(1)).optional(),
  contributes: ManifestV2ContributionsSchema,
}).strict();

export const AnyManifestSchema = z.union([ManifestV2Schema, ManifestSchema]);

export type ExtensionManifest = z.infer<typeof ManifestSchema>;
export type ExtensionManifestV2 = z.infer<typeof ManifestV2Schema>;
export type AnyExtensionManifest = z.infer<typeof AnyManifestSchema>;
export type WorkbenchManifest = z.infer<typeof WorkbenchManifestSchema>;
export type AgentManifest = z.infer<typeof AgentManifestSchema>;
export type SkillManifest = z.infer<typeof SkillManifestSchema>;
export type CliProviderManifest = z.infer<typeof CliProviderManifestSchema>;
export type ModelBindingManifest = z.infer<typeof ModelBindingManifestSchema>;
export type ToolManifest = z.infer<typeof ToolManifestSchema>;

/* ============================================================================
 * Helpers
 * ==========================================================================*/

export interface ManifestParseResult {
  ok: boolean;
  manifest?: ExtensionManifest;
  error?: z.ZodError;
  /** 警告 — schema 通过了但有 soft issue（如缺 description）。 */
  warnings: string[];
}

export function parseManifest(input: unknown): ManifestParseResult {
  const r = ManifestSchema.safeParse(input);
  const warnings: string[] = [];
  if (!r.success) return { ok: false, error: r.error, warnings };

  const m = r.data;
  if (!('description' in m) || m.description === undefined) {
    warnings.push('description missing — Settings UI will fall back to displayName');
  }
  return { ok: true, manifest: m, warnings };
}

export interface AnyManifestParseResult {
  ok: boolean;
  manifest?: AnyExtensionManifest;
  error?: z.ZodError;
  warnings: string[];
}

export function parseAnyManifest(input: unknown): AnyManifestParseResult {
  const result = AnyManifestSchema.safeParse(input);
  const warnings: string[] = [];
  if (!result.success) return { ok: false, error: result.error, warnings };
  if (result.data.description === undefined) {
    warnings.push('description missing — Settings UI will fall back to displayName');
  }
  return { ok: true, manifest: result.data, warnings };
}

/** Normalize the sanctioned v1 compatibility shape at the scanner boundary. */
export function normalizeManifest(manifest: AnyExtensionManifest): ExtensionManifestV2 {
  if (manifest.schemaVersion === 2) return manifest;

  const shared = manifest.provides;
  const contributes: z.input<typeof ManifestV2ContributionsSchema> = {
    ...('agents' in shared && shared.agents ? { agents: shared.agents } : {}),
    ...('agent' in shared && shared.agent ? { agents: [shared.agent] } : {}),
    ...('skills' in shared && shared.skills ? { skills: shared.skills } : {}),
    ...('tools' in shared && shared.tools ? { tools: shared.tools } : {}),
    ...('events' in shared && shared.events ? { events: shared.events } : {}),
    ...('surfaces' in shared && shared.surfaces ? { surfaces: shared.surfaces } : {}),
    ...('commands' in shared && shared.commands ? { commands: shared.commands } : {}),
    ...('mcp' in shared && shared.mcp ? { mcp: shared.mcp } : {}),
    ...('memory' in shared && shared.memory ? { memory: shared.memory } : {}),
    ...('cliProvider' in shared && shared.cliProvider ? { cliProviders: [shared.cliProvider] } : {}),
    ...('modelBinding' in shared && shared.modelBinding ? { modelBindings: [shared.modelBinding] } : {}),
  };

  if (manifest.kind === 'workbench') {
    const workbench = manifest.provides.workbench;
    const localId = workbench.id.replace(/^wb:/u, '').replace(/[^a-z0-9.-]+/gu, '-') || 'main';
    const panelId = `${localId}.content`;
    const declaredPanes = (['left', 'center'] as const).filter((pane) => workbench.panes?.[pane]);
    const panes = declaredPanes.length > 0
      ? declaredPanes
      : workbench.surface === 'split'
        ? (['left', 'center'] as const)
        : [];
    const placementId = (pane: 'left' | 'center'): 'sidebar' | 'workspace' =>
      pane === 'left' ? 'sidebar' : 'workspace';
    const placements = panes.length > 0
      ? panes.map((pane) => ({
          id: placementId(pane),
          panelType: { extension: 'self' as const, id: panelId },
          initialProps: {
            pane,
            ...(workbench.panes?.[pane] ?? {}),
          },
        }))
      : [{ id: 'content', panelType: { extension: 'self' as const, id: panelId } }];
    const paneSize = (pane: 'left' | 'center', fallback: number): number => {
      const config = workbench.panes?.[pane];
      return config?.defaultWidth ?? config?.width ?? config?.minWidth ?? fallback;
    };
    const layout = panes.length > 1
      ? {
          version: 2,
          root: {
            kind: 'split' as const,
            direction: 'horizontal' as const,
            sizes: panes.map((pane) => paneSize(pane, pane === 'left' ? 360 : 840)),
            children: panes.map((pane) => ({
              kind: 'tabs' as const,
              placements: [placementId(pane)],
              active: placementId(pane),
            })),
          },
        }
      : {
          version: 2,
          root: {
            kind: 'tabs' as const,
            placements: [placements[0]!.id],
            active: placements[0]!.id,
          },
        };
    contributes.panelTypes = [{
      id: panelId,
      runtime: manifest.entry?.standalone ? 'iframe' : 'inline',
      entry: manifest.entry?.frontend ?? manifest.entry?.standalone?.readyProbe ?? './index.html',
    }];
    contributes.pages = [{
      id: localId,
      title: manifest.displayName,
      icon: manifest.provides.workbench.icon ?? manifest.icon,
      cardinality: 'singleton',
      restorePolicy: 'project',
      layout,
      layoutVersion: 2,
      panels: placements,
      ...(workbench.matchProduces ? { matchProduces: workbench.matchProduces } : {}),
      ...(workbench.preferredAgent ? { preferredAgent: workbench.preferredAgent } : {}),
    }];
    if (!workbench.hidden) {
      contributes.activities = [{
        id: `${localId}.launcher`,
        title: manifest.displayName,
        icon: workbench.icon ?? manifest.icon,
        order: workbench.position,
        category: workbench.category ?? 'general',
        pageType: { extension: 'self', id: localId },
      }];
    }
  }

  const {
    kind: _kind,
    provides: _provides,
    schemaVersion: _schemaVersion,
    ...base
  } = manifest;
  return ManifestV2Schema.parse({
    ...base,
    schemaVersion: 2,
    categories: [manifest.kind],
    contributes,
  });
}
