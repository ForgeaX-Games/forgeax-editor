/**
 * Provider-neutral contract for game-state-driven generated visuals.
 *
 * The game world is authoritative. Games publish semantic, JSON-safe intent
 * plus ordered discontinuities; Studio-side adapters turn them into provider
 * inputs and present the resulting media without feeding it back into ECS.
 */
import { z } from 'zod';

const Vector2Schema = z.tuple([z.number().finite(), z.number().finite()]);
const Vector3Schema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);

export type VisualVector2 = z.infer<typeof Vector2Schema>;
export type VisualVector3 = z.infer<typeof Vector3Schema>;

export const VISUAL_INTENT_RESOURCE_KEY = 'ForgeaxVisualIntent' as const;
export const VISUAL_PRESENTATION_PROGRAM_RESOURCE_KEY = 'ForgeaxVisualPresentationProgram' as const;

export const VisualActorSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  position: Vector3Schema.optional(),
  facing: Vector3Schema.optional(),
  stateTags: z.array(z.string().min(1)).default([]),
}).strict();

export type VisualActor = z.infer<typeof VisualActorSchema>;

export const VisualIntentSchema = z.object({
  scene: z.object({
    summary: z.string().min(1).optional(),
    location: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).default([]),
    actors: z.array(VisualActorSchema).default([]),
    /**
     * Stays stable while an adapter should preserve its temporal context.
     * Changing it is semantic; a provider may reset its own continuity cache.
     */
    continuityKey: z.string().min(1).optional(),
  }).strict(),
  camera: z.object({
    mode: z.enum([
      'first-person',
      'third-person',
      'top-down',
      'side',
      'cinematic',
      'unknown',
    ]).default('unknown'),
    framing: z.enum([
      'first-person',
      'third-person',
      'wide',
      'medium',
      'close-up',
      'overhead',
    ]).optional(),
    motion: z.enum([
      'fixed',
      'follow',
      'orbit',
      'pan',
      'dolly',
      'handheld',
    ]).optional(),
    position: Vector3Schema.optional(),
    forward: Vector3Schema.optional(),
    fovYDeg: z.number().finite().positive().max(180).optional(),
    velocity: Vector3Schema.optional(),
  }).strict().optional(),
}).strict();

export type VisualIntent = z.infer<typeof VisualIntentSchema>;
export type VisualIntentInput = z.input<typeof VisualIntentSchema>;

export const VisualIntentEnvelopeSchema = z.object({
  revision: z.number().int().nonnegative(),
  value: VisualIntentSchema,
}).strict();

export type VisualIntentEnvelope = z.infer<typeof VisualIntentEnvelopeSchema>;

export const VisualPlaybackIntentSchema = z.enum(['running', 'paused']);
export type VisualPlaybackIntent = z.infer<typeof VisualPlaybackIntentSchema>;

const VisualScalarSchema = z.union([z.boolean(), z.number().finite(), z.string()]);
export type VisualScalar = z.infer<typeof VisualScalarSchema>;

const VisualTimelineOverrideSchema = z.object({
  /** Manifest effect phase containing the timeline track. */
  phase: z.enum(['enter', 'exit', 'trigger']),
  /** Manifest motion-track id; never a Provider command. */
  trackId: z.string().min(1),
  durationChunks: z.number().int().positive().max(120),
  interpolation: z.enum(['step', 'linear']),
  keyframes: z.array(z.object({
    at: z.number().finite().min(0).max(1),
    value: z.number().finite().min(-1).max(1),
  }).strict()).min(2).max(360),
}).strict().superRefine((timeline, context) => {
  timeline.keyframes.forEach((frame, index, frames) => {
    if (index > 0 && frame.at <= frames[index - 1]!.at) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['keyframes', index, 'at'],
        message: 'Timeline override keyframes must be strictly increasing',
      });
    }
  });
});

const VisualEffectOverridesSchema = z.object({
  timelines: z.array(VisualTimelineOverrideSchema).max(16).default([]),
}).strict().superRefine((overrides, context) => {
  const seen = new Set<string>();
  overrides.timelines.forEach((timeline, index) => {
    const key = `${timeline.phase}\u0000${timeline.trackId}`;
    if (seen.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timelines', index],
        message: 'Timeline overrides must be unique per phase and trackId',
      });
    }
    seen.add(key);
  });
});
export type VisualTimelineOverride = z.infer<typeof VisualTimelineOverrideSchema>;
export type VisualEffectOverrides = z.infer<typeof VisualEffectOverridesSchema>;

export const VisualBehaviorInstanceSchema = z.object({
  recipeKey: z.string().min(1),
  instanceId: z.string().min(1),
  /** Game-owned press/order sequencing for deterministic behavior stacks. */
  order: z.number().int().nonnegative().optional(),
  actorId: z.string().min(1).optional(),
  targetId: z.string().min(1).optional(),
  intensity: z.number().finite().min(0).max(1).optional(),
  parameters: z.record(VisualScalarSchema).optional(),
  effectOverrides: VisualEffectOverridesSchema.optional(),
}).strict();
export type VisualBehaviorInstance = z.infer<typeof VisualBehaviorInstanceSchema>;

const VisualTransitionPayloadSchema = z.object({
  recipeKey: z.string().min(1),
  instanceId: z.string().min(1),
  order: z.number().int().nonnegative().optional(),
  actorId: z.string().min(1).optional(),
  targetId: z.string().min(1).optional(),
  intensity: z.number().finite().min(0).max(1).optional(),
  parameters: z.record(VisualScalarSchema).optional(),
  effectOverrides: VisualEffectOverridesSchema.optional(),
}).strict();

export const VisualBehaviorTransitionSchema = z.discriminatedUnion('type', [
  z.object({
    sequence: z.number().int().positive(),
    operationId: z.string().min(1),
    programRevision: z.number().int().nonnegative(),
    type: z.literal('behavior-enter'),
    instance: VisualTransitionPayloadSchema,
  }).strict(),
  z.object({
    sequence: z.number().int().positive(),
    operationId: z.string().min(1),
    programRevision: z.number().int().nonnegative(),
    type: z.literal('behavior-exit'),
    instanceId: z.string().min(1),
    instance: VisualTransitionPayloadSchema,
  }).strict(),
  z.object({
    sequence: z.number().int().positive(),
    operationId: z.string().min(1),
    programRevision: z.number().int().nonnegative(),
    type: z.literal('behavior-trigger'),
    instance: VisualTransitionPayloadSchema,
  }).strict(),
]);
export type VisualBehaviorTransition = z.infer<typeof VisualBehaviorTransitionSchema>;

export const VisualPresentationProgramSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  creativeDirection: z.string().max(1_000).optional(),
  lifecycle: z.object({
    desiredPlayback: VisualPlaybackIntentSchema,
    restartSequence: z.number().int().nonnegative(),
  }).strict(),
  signals: z.record(VisualScalarSchema),
  activeBehaviors: z.array(VisualBehaviorInstanceSchema),
  journal: z.object({
    nextSequence: z.number().int().positive(),
    dropped: z.number().int().nonnegative(),
    entries: z.array(VisualBehaviorTransitionSchema),
  }).strict(),
  operations: z.array(z.object({
    operationId: z.string().min(1),
    payloadHash: z.string().min(1),
    receipt: z.object({
      disposition: z.enum(['accepted', 'duplicate']),
      revision: z.number().int().nonnegative(),
      transitionSequences: z.array(z.number().int().positive()),
    }).strict(),
  }).strict()).default([]),
}).strict().superRefine((program, context) => {
  const seen = new Set<string>();
  program.activeBehaviors.forEach((instance, index) => {
    if (seen.has(instance.instanceId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['activeBehaviors', index, 'instanceId'],
        message: 'Active behavior instanceId values must be unique',
      });
    }
    seen.add(instance.instanceId);
  });
});
export type VisualPresentationProgram = z.infer<typeof VisualPresentationProgramSchema>;

export const VisualPresentationCommitSchema = z.object({
  operationId: z.string().min(1),
  state: z.object({
    creativeDirection: z.string().max(1_000).optional(),
    desiredPlayback: VisualPlaybackIntentSchema.default('running'),
    restartSequence: z.number().int().nonnegative().default(0),
    signals: z.record(VisualScalarSchema).default({}),
    activeBehaviors: z.array(VisualBehaviorInstanceSchema).default([]),
  }).strict(),
  triggers: z.array(VisualBehaviorInstanceSchema).default([]),
}).strict().superRefine((commit, context) => {
  const seen = new Set<string>();
  commit.state.activeBehaviors.forEach((instance, index) => {
    if (seen.has(instance.instanceId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['state', 'activeBehaviors', index, 'instanceId'],
        message: 'Active behavior instanceId values must be unique',
      });
    }
    seen.add(instance.instanceId);
  });
});
export type VisualPresentationCommit = z.infer<typeof VisualPresentationCommitSchema>;
export type VisualPresentationCommitInput = z.input<typeof VisualPresentationCommitSchema>;

export const VisualPresentationReceiptSchema = z.object({
  operationId: z.string().min(1),
  disposition: z.enum(['accepted', 'duplicate']),
  revision: z.number().int().nonnegative(),
  transitionSequences: z.array(z.number().int().positive()),
}).strict();
export type VisualPresentationReceipt = z.infer<typeof VisualPresentationReceiptSchema>;

export const VisualWorldRunSchema = z.enum(['edit', 'play']);
export type VisualWorldRun = z.infer<typeof VisualWorldRunSchema>;

/**
 * Identifies the world that produced a source snapshot. Consumers must discard
 * asynchronous work when `epoch` changes, because a play world is destroyed on
 * Stop and a Studio game switch rebuilds the editor realm.
 */
export const VisualWorldStampSchema = z.object({
  epoch: z.number().int().nonnegative(),
  run: VisualWorldRunSchema,
  intentRevision: z.number().int().nonnegative().optional(),
  programRevision: z.number().int().nonnegative().optional(),
  transitionSequence: z.number().int().nonnegative(),
}).strict();

export type VisualWorldStamp = z.infer<typeof VisualWorldStampSchema>;

/**
 * Host-side observation contract shared by the editor source and presentation
 * plugins. `TStream` keeps this package free of DOM dependencies while browser
 * hosts can specialize it to `MediaStream`.
 */
export interface VisualSourceCamera {
  readonly entity: number;
  readonly position: readonly [number, number, number];
  readonly forward: readonly [number, number, number];
  readonly fovYDeg?: number;
}

export interface VisualViewportInfo {
  readonly width: number;
  readonly height: number;
}

export interface VisualSourceSnapshot {
  readonly available: boolean;
  readonly stamp?: VisualWorldStamp;
  readonly intent?: VisualIntentEnvelope;
  readonly program?: VisualPresentationProgram;
  readonly camera?: VisualSourceCamera;
  readonly viewport?: VisualViewportInfo;
}

export interface VisualViewportLease<TStream = unknown> {
  readonly stream: TStream;
  release(): void;
}

export interface VisualSource<TStream = unknown, TImage = unknown> {
  getSnapshot(): VisualSourceSnapshot;
  subscribe(listener: () => void): () => void;
  leaseViewportTrack(fps: number): VisualViewportLease<TStream>;
  /**
   * True when the active game publishes a loadable
   * `visual-priors/manifest.json`. Seed-image backends should stay off the
   * default Panel path while this is false.
   */
  hasPriorCatalog(): Promise<boolean>;
  resolveSeedImage(continuityKey: string): Promise<TImage>;
  /**
   * Returns undefined only when the presentation catalog is absent. A
   * malformed catalog, an inaccessible file, or a missing requested key must
   * reject so the presenter can fail closed.
   */
  resolvePresentation(continuityKey: string): Promise<VisualPresentationEntry | undefined>;
  dispose(): void;
}

export const VisualInputCapabilitySchema = z.enum([
  'semantic-intent',
  'viewport-track',
  'seed-image',
  'camera-pose',
]);

export type VisualInputCapability = z.infer<typeof VisualInputCapabilitySchema>;

export const VisualOutputCapabilitySchema = z.enum([
  'presentation-stream',
  'telemetry',
]);

export type VisualOutputCapability = z.infer<typeof VisualOutputCapabilitySchema>;

/**
 * Durable product controls exposed by a backend profile. This is deliberately
 * separate from VisualInputCapability: the former describes Panel direction
 * controls, while the latter describes inputs a provider consumes from the
 * game/editor world.
 */
/**
 * Direction controls the Panel/Presenter know how to render and validate.
 * Providers must not declare controls outside this set; priors stay on the
 * game-owned `continuityKey` catalog, not as a Panel control.
 */
export const VisualBackendControlSchema = z.enum([
  'prompt',
  'seed',
  'quality',
  'rotation-speed',
  'attention-window',
  'kv-cache-reset',
]);

export type VisualBackendControl = z.infer<typeof VisualBackendControlSchema>;

export const VisualBackendProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  requiredInputs: z.array(VisualInputCapabilitySchema),
  optionalInputs: z.array(VisualInputCapabilitySchema).default([]),
  outputs: z.array(VisualOutputCapabilitySchema).min(1),
  controls: z.array(VisualBackendControlSchema).default([]),
}).strict();

export type VisualBackendProfile = z.infer<typeof VisualBackendProfileSchema>;

export const VisualBackendDescriptorSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  profiles: z.array(VisualBackendProfileSchema).min(1),
}).strict();

export type VisualBackendDescriptor = z.infer<typeof VisualBackendDescriptorSchema>;

/**
 * Game-owned image priors. The manifest lives at
 * `.forgeax/games/<slug>/visual-priors/manifest.json`; image paths are
 * relative to the game root and continuity keys remain opaque to providers.
 */
export const VisualPriorEntrySchema = z.object({
  continuityKey: z.string().min(1),
  image: z.string().min(1),
  label: z.string().min(1).optional(),
}).strict();

export type VisualPriorEntry = z.infer<typeof VisualPriorEntrySchema>;

export const VisualPriorManifestSchema = z.object({
  version: z.literal(1),
  entries: z.array(VisualPriorEntrySchema),
}).strict().superRefine((manifest, context) => {
  const seen = new Map<string, number>();
  manifest.entries.forEach((entry, index) => {
    const previousIndex = seen.get(entry.continuityKey);
    if (previousIndex !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entries', index, 'continuityKey'],
        message: `Duplicate continuity key; first declared at entry ${previousIndex}`,
      });
      return;
    }
    seen.set(entry.continuityKey, index);
  });
});

export type VisualPriorManifest = z.infer<typeof VisualPriorManifestSchema>;

export const VisualMotionTargetV1Schema = z.enum([
  'navigation.forward-rate',
  'navigation.strafe-rate',
  'camera.rotation.pitch-rate',
  'camera.rotation.yaw-rate',
  'camera.rotation.roll-rate',
  'camera.translation.x-rate',
  'camera.translation.y-rate',
  'camera.translation.z-rate',
  'camera.offset.x',
  'camera.offset.y',
  'camera.offset.z',
  'camera.orbit.radius',
]);
export type VisualMotionTargetV1 = z.infer<typeof VisualMotionTargetV1Schema>;

export const VisualPromptEffectSchema = z.object({
  id: z.string().min(1),
  slot: z.string().min(1),
  text: z.string().min(1),
  mode: z.enum(['append', 'replace']),
  priority: z.number().int().default(0),
  required: z.boolean().default(false),
}).strict();
export type VisualPromptEffect = z.infer<typeof VisualPromptEffectSchema>;

export const VisualMotionTrackSchema = z.object({
  id: z.string().min(1),
  target: VisualMotionTargetV1Schema,
  blend: z.enum(['add', 'replace']),
  priority: z.number().int().default(0),
  required: z.boolean().default(false),
  scaleByIntensity: z.boolean().default(false),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('constant'), value: z.number().finite().min(-1).max(1) }).strict(),
    z.object({
      kind: z.literal('signal'),
      key: z.string().min(1),
      scale: z.number().finite().default(1),
      invert: z.boolean().default(false),
    }).strict(),
  ]),
  timeline: z.object({
    /**
     * Provider-progress duration. One unit advances on each confirmed
     * presentation tick (for LingBot: one `chunk_complete`).
     */
    durationChunks: z.number().int().positive().max(120),
    interpolation: z.enum(['step', 'linear']),
    keyframes: z.array(z.object({
      at: z.number().finite().min(0).max(1),
      value: z.number().finite().min(-1).max(1),
    }).strict()).min(2),
  }).strict().optional(),
}).strict().superRefine((track, context) => {
  track.timeline?.keyframes.forEach((frame, index, frames) => {
    if (index > 0 && frame.at <= frames[index - 1]!.at) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timeline', 'keyframes', index, 'at'],
        message: 'Timeline keyframes must be strictly increasing',
      });
    }
  });
});
export type VisualMotionTrack = z.infer<typeof VisualMotionTrackSchema>;

export const VisualEffectBundleSchema = z.object({
  prompt: z.array(VisualPromptEffectSchema).default([]),
  motion: z.array(VisualMotionTrackSchema).default([]),
}).strict();
export type VisualEffectBundle = z.infer<typeof VisualEffectBundleSchema>;

export const VisualRecipeSchema = z.object({
  key: z.string().min(1),
  priority: z.number().int().default(0),
  enter: VisualEffectBundleSchema.optional(),
  active: VisualEffectBundleSchema.optional(),
  exit: VisualEffectBundleSchema.optional(),
  trigger: VisualEffectBundleSchema.optional(),
}).strict();
export type VisualRecipe = z.infer<typeof VisualRecipeSchema>;

export const VisualSignalDeclarationSchema = z.object({
  key: z.string().min(1),
  type: z.enum(['boolean', 'number', 'string']),
  default: VisualScalarSchema,
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
}).strict().superRefine((signal, context) => {
  if (typeof signal.default !== signal.type) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['default'], message: 'Signal default must match its declared type' });
  }
  if (signal.type !== 'number' && (signal.min !== undefined || signal.max !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Only number signals can declare a range' });
  }
  if (signal.min !== undefined && signal.max !== undefined && signal.min > signal.max) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Signal min cannot exceed max' });
  }
});
export type VisualSignalDeclaration = z.infer<typeof VisualSignalDeclarationSchema>;

export const VisualPresentationEntrySchema = z.object({
  continuityKey: z.string().min(1),
  /**
   * Game-authored prose order. Slot merge is plugin-private, but an entry
   * controls the final Provider-neutral sentence ordering.
   */
  promptOrder: z.array(z.string().min(1)).default([]),
  signals: z.array(VisualSignalDeclarationSchema).default([]),
  baseline: VisualEffectBundleSchema.default({}),
  recipes: z.array(VisualRecipeSchema).default([]),
}).strict().superRefine((entry, context) => {
  for (const [field, values] of [
    ['signals', entry.signals.map((signal) => signal.key)],
    ['recipes', entry.recipes.map((recipe) => recipe.key)],
  ] as const) {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field, index],
        message: `Duplicate ${field.slice(0, -1)} key "${value}"`,
      });
      seen.add(value);
    });
  }
  const seenSlots = new Set<string>();
  entry.promptOrder.forEach((slot, index) => {
    if (seenSlots.has(slot)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['promptOrder', index],
        message: `Duplicate prompt slot "${slot}"`,
      });
    }
    seenSlots.add(slot);
  });
});
export type VisualPresentationEntry = z.infer<typeof VisualPresentationEntrySchema>;

export const VisualPresentationManifestSchema = z.object({
  version: z.literal(2),
  entries: z.array(VisualPresentationEntrySchema),
}).strict().superRefine((manifest, context) => {
  const seen = new Map<string, number>();
  manifest.entries.forEach((entry, index) => {
    const previousIndex = seen.get(entry.continuityKey);
    if (previousIndex !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entries', index, 'continuityKey'],
        message: `Duplicate continuity key; first declared at entry ${previousIndex}`,
      });
      return;
    }
    seen.set(entry.continuityKey, index);
  });
});

export type VisualPresentationManifest = z.infer<typeof VisualPresentationManifestSchema>;

export const VisualSessionPhaseSchema = z.enum([
  'idle',
  'waiting',
  'connecting',
  'live',
  'degraded',
  'failed',
  'stopped',
]);

export type VisualSessionPhase = z.infer<typeof VisualSessionPhaseSchema>;

export const VisualPresentationIssueSchema = z.object({
  code: z.enum([
    'disabled',
    'missing-input',
    'unsupported-input',
    'backend-unavailable',
    'unauthorized',
    'busy',
    'quota',
    'transport',
    'source-lost',
    'stale-epoch',
    'cue-overflow',
    'command-rejected',
  ]),
  message: z.string().min(1),
  retryable: z.boolean(),
}).strict();

export type VisualPresentationIssue = z.infer<typeof VisualPresentationIssueSchema>;

export const VisualPresentationStatusSchema = z.object({
  phase: VisualSessionPhaseSchema,
  /** Human-readable, non-authoritative progress for presentation diagnostics. */
  activity: z.string().min(1).optional(),
  backendId: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
  appliedIntentRevision: z.number().int().nonnegative().optional(),
  appliedTransitionSequence: z.number().int().nonnegative().optional(),
  outputSequence: z.number().int().nonnegative().optional(),
  latencyMs: z.number().finite().nonnegative().optional(),
  modelFps: z.number().finite().nonnegative().optional(),
  presentedFps: z.number().finite().nonnegative().optional(),
  droppedUpdates: z.number().int().nonnegative().optional(),
  /**
   * Presentation diagnostics only. Provider-specific runtime detail is opaque
   * here so shared contracts do not grow a second Provider command vocabulary.
   */
  runtime: z.record(z.unknown()).optional(),
  issue: VisualPresentationIssueSchema.optional(),
}).strict();

export type VisualPresentationStatus = z.infer<typeof VisualPresentationStatusSchema>;

/**
 * The subset of the ECS resource store that the portable helpers require.
 * It deliberately avoids importing an engine implementation into L0.
 */
export interface VisualResourceStore {
  hasResource(key: string): boolean;
  getResource<T>(key: string): T;
  insertResource<T>(key: string, value: T): void;
}

export interface VisualIntentWrite {
  readonly revision: number;
  readonly changed: boolean;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableInstances(
  instances: readonly VisualBehaviorInstance[],
): VisualBehaviorInstance[] {
  return [...instances].sort((left, right) => (
    (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER)
    || (left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0)
  ));
}

export function getVisualIntent(store: VisualResourceStore): VisualIntentEnvelope | undefined {
  if (!store.hasResource(VISUAL_INTENT_RESOURCE_KEY)) return undefined;
  return VisualIntentEnvelopeSchema.parse(
    store.getResource<unknown>(VISUAL_INTENT_RESOURCE_KEY),
  );
}

export function getVisualPresentationProgram(
  store: VisualResourceStore,
): VisualPresentationProgram | undefined {
  if (!store.hasResource(VISUAL_PRESENTATION_PROGRAM_RESOURCE_KEY)) return undefined;
  return VisualPresentationProgramSchema.parse(
    store.getResource<unknown>(VISUAL_PRESENTATION_PROGRAM_RESOURCE_KEY),
  );
}

/**
 * Atomically replaces the desired presentation state and records derived
 * enter/exit edges plus explicit triggers. Retained operation IDs are exactly
 * idempotent; once evicted from the bounded ledger, the ID is a new operation.
 */
export function commitVisualPresentation(
  store: VisualResourceStore,
  commit: VisualPresentationCommitInput,
  options: { readonly journalCapacity?: number; readonly operationCapacity?: number } = {},
): VisualPresentationReceipt {
  const parsed = VisualPresentationCommitSchema.parse(commit);
  const journalCapacity = options.journalCapacity ?? 64;
  const operationCapacity = options.operationCapacity ?? 128;
  if (!Number.isSafeInteger(journalCapacity) || journalCapacity < 1) {
    throw new RangeError('journalCapacity must be a positive safe integer');
  }
  if (!Number.isSafeInteger(operationCapacity) || operationCapacity < 1) {
    throw new RangeError('operationCapacity must be a positive safe integer');
  }
  const payloadHash = canonicalJson(parsed);
  const current = getVisualPresentationProgram(store);
  const prior = current ?? {
    version: 1 as const,
    revision: 0,
    lifecycle: { desiredPlayback: 'running' as const, restartSequence: 0 },
    signals: {},
    activeBehaviors: [],
    journal: { nextSequence: 1, dropped: 0, entries: [] },
    operations: [],
  };
  const known = prior.operations.find((entry) => entry.operationId === parsed.operationId);
  if (known) {
    if (known.payloadHash !== payloadHash) {
      throw new Error(`idempotency-conflict: operation "${parsed.operationId}" has a different payload`);
    }
    return { operationId: parsed.operationId, ...known.receipt, disposition: 'duplicate' };
  }

  const activeBehaviors = stableInstances(parsed.state.activeBehaviors);
  const durable = {
    ...(parsed.state.creativeDirection ? { creativeDirection: parsed.state.creativeDirection } : {}),
    lifecycle: {
      desiredPlayback: parsed.state.desiredPlayback,
      restartSequence: parsed.state.restartSequence,
    },
    signals: parsed.state.signals,
    activeBehaviors,
  };
  const before = {
    ...(prior.creativeDirection ? { creativeDirection: prior.creativeDirection } : {}),
    lifecycle: prior.lifecycle,
    signals: prior.signals,
    activeBehaviors: stableInstances(prior.activeBehaviors),
  };
  const changed = canonicalJson(before) !== canonicalJson(durable);
  const revision = changed ? prior.revision + 1 : prior.revision;
  const previousById = new Map(prior.activeBehaviors.map((instance) => [instance.instanceId, instance]));
  const nextById = new Map(activeBehaviors.map((instance) => [instance.instanceId, instance]));
  type PendingTransition =
    | { readonly type: 'behavior-enter'; readonly instance: VisualBehaviorInstance }
    | {
        readonly type: 'behavior-exit';
        readonly instanceId: string;
        readonly instance: VisualBehaviorInstance;
      }
    | { readonly type: 'behavior-trigger'; readonly instance: VisualBehaviorInstance };
  const pending: PendingTransition[] = [];
  for (const instance of activeBehaviors) {
    if (!previousById.has(instance.instanceId)) pending.push({ type: 'behavior-enter', instance });
  }
  for (const instance of prior.activeBehaviors) {
    if (!nextById.has(instance.instanceId)) pending.push({
      type: 'behavior-exit',
      instanceId: instance.instanceId,
      instance,
    });
  }
  for (const instance of stableInstances(parsed.triggers)) pending.push({ type: 'behavior-trigger', instance });
  const transitions = pending.map((transition, index) => ({
    ...transition,
    sequence: prior.journal.nextSequence + index,
    operationId: parsed.operationId,
    programRevision: revision,
  })) as VisualBehaviorTransition[];
  const allEntries = [...prior.journal.entries, ...transitions];
  const overflow = Math.max(0, allEntries.length - journalCapacity);
  const receipt: VisualPresentationReceipt = {
    operationId: parsed.operationId,
    disposition: 'accepted',
    revision,
    transitionSequences: transitions.map((transition) => transition.sequence),
  };
  const operations = [...prior.operations, {
    operationId: parsed.operationId,
    payloadHash,
    receipt: {
      disposition: 'accepted' as const,
      revision,
      transitionSequences: receipt.transitionSequences,
    },
  }].slice(-operationCapacity);
  const next = VisualPresentationProgramSchema.parse({
    version: 1,
    revision,
    ...durable,
    journal: {
      nextSequence: prior.journal.nextSequence + transitions.length,
      dropped: prior.journal.dropped + overflow,
      entries: overflow ? allEntries.slice(overflow) : allEntries,
    },
    operations,
  });
  store.insertResource(VISUAL_PRESENTATION_PROGRAM_RESOURCE_KEY, next);
  return receipt;
}

/**
 * Replaces the complete durable visual state. Identical values retain the
 * revision, which makes per-frame publishing safe and cheap for game systems.
 */
export function setVisualIntent(
  store: VisualResourceStore,
  value: VisualIntentInput,
): VisualIntentWrite {
  const next = VisualIntentSchema.parse(value);
  const current = getVisualIntent(store);
  if (current && canonicalJson(current.value) === canonicalJson(next)) {
    return { revision: current.revision, changed: false };
  }

  const envelope: VisualIntentEnvelope = {
    revision: (current?.revision ?? -1) + 1,
    value: next,
  };
  store.insertResource(VISUAL_INTENT_RESOURCE_KEY, envelope);
  return { revision: envelope.revision, changed: true };
}

export function clearVisualIntent(store: VisualResourceStore): void {
  if (!store.hasResource(VISUAL_INTENT_RESOURCE_KEY)) return;
  store.insertResource<VisualIntentEnvelope>(VISUAL_INTENT_RESOURCE_KEY, {
    revision: (getVisualIntent(store)?.revision ?? -1) + 1,
    value: VisualIntentSchema.parse({
      scene: {},
    }),
  });
}

