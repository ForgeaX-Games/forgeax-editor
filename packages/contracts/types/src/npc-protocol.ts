/**
 * Digital-Life NPC brain wire protocol — shared Schema-as-Contract SSOT.
 *
 * Games declare the actions their NPCs can take through generic Affordances. The
 * contracts/Brain layers know only the affordance shape, never concrete game actions:
 * adding an action therefore requires zero edits here or in the Brain (§2.5).
 *
 * NpcDecisionWire intentionally excludes memoryOps. Memory extraction is internal to
 * the Brain and must be removed before a decision crosses the game wire boundary.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const NPC_PROTOCOL_VERSION = 1 as const;

export const NPC_DECISION_DEADLINE_PRESETS_MS = Object.freeze({
  fast: 3_000,
  balanced: 6_000,
  patient: 12_000,
} as const);
export const NPC_DEFAULT_DECISION_DEADLINE_PRESET = 'balanced' as const;

export const NPC_LIMITS = {
  idLength: 128,
  factLength: 200,
  textLength: 200,
  activityLength: 80,
  moodLength: 40,
  utteranceLineLength: 48,
  maxNearby: 64,
  maxNearbyFacts: 16,
  maxEvents: 32,
  maxRecentEvents: 24,
  maxAffordances: 64,
  maxAffordanceParams: 16,
  maxLiteralValues: 32,
  maxIntentParams: 16,
  maxUtteranceLines: 3,
  maxEmotionTargets: 16,
  maxIntentTtlSec: 300,
  minDecisionDeadlineMs: 1_000,
  maxDecisionDeadlineMs: 30_000,
  maxResumeReplay: 1024,
  maxSessionNpcs: 128,
  maxBatchSize: 64,
  maxSummaryMetrics: 32,
  maxSummaryTags: 32,
  maxBudgetUnits: Number.MAX_SAFE_INTEGER,
  maxWireSeq: Number.MAX_SAFE_INTEGER,
} as const;

export function isSupportedNpcProtocolVersion(value: unknown): value is typeof NPC_PROTOCOL_VERSION {
  return value === NPC_PROTOCOL_VERSION;
}

const BoundedId = z
  .string()
  .min(1)
  .max(NPC_LIMITS.idLength)
  /** Dots are intentional: producer-owned Soul ids use `<game>.<npc>`. */
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u);
const Fact = z.string().min(1).max(NPC_LIMITS.factLength);
const WireSeq = z.number().int().min(0).max(NPC_LIMITS.maxWireSeq);
const PositiveWireSeq = z.number().int().min(1).max(NPC_LIMITS.maxWireSeq);
const TimestampMs = z.number().int().nonnegative().max(NPC_LIMITS.maxWireSeq);
const BudgetUnits = z.number().int().nonnegative().max(NPC_LIMITS.maxBudgetUnits);
const TrustTier = z.enum(['own', 'imported']);

function boundedRecord<V extends z.ZodTypeAny>(value: V, maxEntries: number) {
  return z.record(BoundedId, value).refine((record) => Object.keys(record).length <= maxEntries, {
    message: `record must contain at most ${maxEntries} entries`,
  });
}

export const Vec2 = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .strict();
export type Vec2 = z.infer<typeof Vec2>;

/**
 * A parameter value is selected from a source the game host owns. The protocol
 * describes how to obtain legal enum values without knowing any concrete action.
 */
export const AffordanceParam = z.discriminatedUnion('source', [
  z.object({ type: z.literal('enum'), source: z.literal('waypoint') }).strict(),
  z.object({ type: z.literal('enum'), source: z.literal('nearby.id') }).strict(),
  z
    .object({
      type: z.literal('enum'),
      source: z.literal('literal'),
      values: z
        .array(z.string().min(1).max(64))
        .min(1)
        .max(NPC_LIMITS.maxLiteralValues),
    })
    .strict(),
]);
export type AffordanceParam = z.infer<typeof AffordanceParam>;

/** Game-declared arbitrary action. No action-name registry exists in contracts. */
export const Affordance = z
  .object({
    action: BoundedId,
    params: boundedRecord(AffordanceParam, NPC_LIMITS.maxAffordanceParams).optional(),
  })
  .strict();
export type Affordance = z.infer<typeof Affordance>;

export const NpcSelfState = z
  .object({
    pos: Vec2,
    activity: z.string().min(1).max(NPC_LIMITS.activityLength),
    mood: z.string().max(NPC_LIMITS.moodLength).optional(),
  })
  .strict();
export type NpcSelfState = z.infer<typeof NpcSelfState>;

export const NearbyEntity = z
  .object({
    kind: BoundedId,
    id: BoundedId,
    pos: Vec2,
    facts: z.array(Fact).max(NPC_LIMITS.maxNearbyFacts),
  })
  .strict();
export type NearbyEntity = z.infer<typeof NearbyEntity>;

const EventScalar = z.union([
  z.string().max(NPC_LIMITS.textLength),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

/** A typed event name plus bounded scalar game-defined fields. */
export const PerceptionEvent = z.object({ type: BoundedId }).catchall(EventScalar);
export type PerceptionEvent = z.infer<typeof PerceptionEvent>;

export const PerceptionSnapshot = z
  .object({
    v: z.literal(NPC_PROTOCOL_VERSION),
    /** Stable idempotency key assigned by the game host. */
    eventId: BoundedId,
    game: BoundedId,
    npcId: BoundedId,
    /** Game simulation time. */
    t: z.number().finite().nonnegative(),
    trigger: z.enum(['player_message', 'event', 'heartbeat', 'attach', 'spotlight']),
    playerId: BoundedId.optional(),
    text: z.string().max(NPC_LIMITS.textLength).optional(),
    self: NpcSelfState,
    nearby: z.array(NearbyEntity).max(NPC_LIMITS.maxNearby),
    events: z.array(PerceptionEvent).max(NPC_LIMITS.maxEvents),
    affordances: z.array(Affordance).max(NPC_LIMITS.maxAffordances),
    recentEvents: z.array(Fact).max(NPC_LIMITS.maxRecentEvents).optional(),
    scene: BoundedId.optional(),
    visibilityGroup: BoundedId.optional(),
  })
  .strict();
export type PerceptionSnapshot = z.infer<typeof PerceptionSnapshot>;

export const NpcIntent = z
  .object({
    /** Must name one of the current snapshot's game-declared affordances. */
    action: BoundedId,
    params: boundedRecord(z.string().max(NPC_LIMITS.idLength), NPC_LIMITS.maxIntentParams).optional(),
    ttlSec: z.number().int().min(1).max(NPC_LIMITS.maxIntentTtlSec),
  })
  .strict();
export type NpcIntent = z.infer<typeof NpcIntent>;

export const NpcUtterance = z
  .object({
    lines: z
      .array(z.string().min(1).max(NPC_LIMITS.utteranceLineLength))
      .min(1)
      .max(NPC_LIMITS.maxUtteranceLines),
  })
  .strict();
export type NpcUtterance = z.infer<typeof NpcUtterance>;

export const NpcEmotion = z
  .object({
    mood: z.string().min(1).max(NPC_LIMITS.moodLength),
    towards: boundedRecord(
      z.number().finite().min(-1).max(1),
      NPC_LIMITS.maxEmotionTargets,
    ).optional(),
  })
  .strict();
export type NpcEmotion = z.infer<typeof NpcEmotion>;

/**
 * Public game wire. Strictness is load-bearing: internal memoryOps (and every
 * other unknown property) fail validation instead of leaking across the boundary.
 */
export const NpcDecisionWire = z
  .object({
    v: z.literal(NPC_PROTOCOL_VERSION),
    npcId: BoundedId,
    seq: PositiveWireSeq,
    intent: NpcIntent.optional(),
    utterance: NpcUtterance.optional(),
    emotion: NpcEmotion.optional(),
    fallback: z.boolean().optional(),
  })
  .strict();
export type NpcDecisionWire = z.infer<typeof NpcDecisionWire>;

/**
 * Per-NPC upper bound for one Brain decision. This is not an intent TTL: it
 * limits how long the Brain may decide before falling back, while intent TTL
 * starts only after the game receives a decision.
 */
export const NpcDecisionDeadline = z.discriminatedUnion('preset', [
  z.object({ preset: z.literal('fast') }).strict(),
  z.object({ preset: z.literal('balanced') }).strict(),
  z.object({ preset: z.literal('patient') }).strict(),
  z.object({
    preset: z.literal('custom'),
    timeoutMs: z
      .number()
      .int()
      .min(NPC_LIMITS.minDecisionDeadlineMs)
      .max(NPC_LIMITS.maxDecisionDeadlineMs),
  }).strict(),
]);
export type NpcDecisionDeadline = z.infer<typeof NpcDecisionDeadline>;

export function resolveNpcDecisionDeadlineMs(
  deadline?: NpcDecisionDeadline,
): number {
  if (!deadline) return NPC_DECISION_DEADLINE_PRESETS_MS[NPC_DEFAULT_DECISION_DEADLINE_PRESET];
  if (deadline.preset === 'custom') return deadline.timeoutMs;
  return NPC_DECISION_DEADLINE_PRESETS_MS[deadline.preset];
}

/** A game-owned NPC identity bound to a reusable producer-owned Soul pack. */
export const NpcSoulBinding = z
  .object({
    npcId: BoundedId,
    soulId: BoundedId.optional(),
    decisionDeadline: NpcDecisionDeadline.optional(),
  })
  .strict();
export type NpcSoulBinding = z.infer<typeof NpcSoulBinding>;

/**
 * Server-resolved identity metadata. Trust is output-only: clients can choose a
 * Soul id, but only the server-side loader may derive its trust tier.
 */
export const NpcLoadedSoulBinding = z
  .object({
    npcId: BoundedId,
    soulId: BoundedId,
    trustTier: TrustTier,
    /** Server-resolved deadline after defaults and host clamps. */
    decisionTimeoutMs: z
      .number()
      .int()
      .min(NPC_LIMITS.minDecisionDeadlineMs)
      .max(NPC_LIMITS.maxDecisionDeadlineMs),
  })
  .strict();
export type NpcLoadedSoulBinding = z.infer<typeof NpcLoadedSoulBinding>;

/** Capability request used by POST /api/npc/session. */
export const NpcSessionRequest = z
  .object({
    game: BoundedId,
    playerId: BoundedId.optional(),
    npcIds: z.array(BoundedId).min(1).max(NPC_LIMITS.maxSessionNpcs).optional(),
    npcs: z.array(NpcSoulBinding).min(1).max(NPC_LIMITS.maxSessionNpcs).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (!request.npcIds && !request.npcs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['npcIds'],
        message: 'npcIds or npcs is required',
      });
    }
  });
export type NpcSessionRequest = z.infer<typeof NpcSessionRequest>;

/** Short-lived bearer capability returned after a session request is accepted. */
export const NpcSessionGrant = z
  .object({
    sessionId: BoundedId,
    token: z.string().min(16).max(512),
    epoch: PositiveWireSeq,
    expiresAt: TimestampMs,
  })
  .strict();
export type NpcSessionGrant = z.infer<typeof NpcSessionGrant>;

export const NpcSessionResponse = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      sessionId: BoundedId,
      token: z.string().min(16).max(512),
      epoch: PositiveWireSeq,
      expiresAt: TimestampMs,
      loaded: z.array(NpcLoadedSoulBinding).max(NPC_LIMITS.maxSessionNpcs),
      wsUrl: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().min(1).max(NPC_LIMITS.textLength),
    })
    .strict(),
]);
export type NpcSessionResponse = z.infer<typeof NpcSessionResponse>;

export const NpcBudgetState = z
  .object({
    state: z.enum(['ok', 'throttled', 'exhausted']).optional(),
    limit: BudgetUnits,
    used: BudgetUnits,
    remaining: BudgetUnits,
    calls: z.object({
      limit: BudgetUnits,
      used: BudgetUnits,
      remaining: BudgetUnits,
    }).strict().optional(),
    tokens: z.object({
      limit: BudgetUnits,
      used: BudgetUnits,
      remaining: BudgetUnits,
    }).strict().optional(),
    resetsAt: TimestampMs.optional(),
  })
  .strict()
  .superRefine((budget, context) => {
    if (budget.used > budget.limit || budget.remaining !== budget.limit - budget.used) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remaining'],
        message: 'remaining must equal limit - used and used must not exceed limit',
      });
    }
  });
export type NpcBudgetState = z.infer<typeof NpcBudgetState>;

export const NpcEpisodeSummary = z
  .object({
    startedAt: TimestampMs,
    endedAt: TimestampMs,
    snapshotCount: WireSeq,
    decisionCount: WireSeq,
    fallbackCount: WireSeq.optional(),
    metrics: boundedRecord(z.number().finite(), NPC_LIMITS.maxSummaryMetrics).optional(),
    tags: boundedRecord(z.string().max(NPC_LIMITS.textLength), NPC_LIMITS.maxSummaryTags).optional(),
  })
  .strict()
  .refine((summary) => summary.endedAt >= summary.startedAt, {
    path: ['endedAt'],
    message: 'endedAt must not precede startedAt',
  });
export type NpcEpisodeSummary = z.infer<typeof NpcEpisodeSummary>;

/* ============================================================================
 * Canonical WebSocket frame vocabulary
 *
 * This module is the only source of truth for WS frame names. Runtime and SDK
 * transports must speak exactly these seven frame types:
 *
 * - session_ready: server -> client, session accepted and ready to stream
 * - snapshot: client -> server, perception snapshot/event from the game
 * - decision: server -> client, public NPC decision for the game to apply
 * - resume: client -> server, request replay after reconnect
 * - episode_end: client -> server, close the session/episode cleanly
 * - heartbeat: either direction, liveness plus cumulative ack
 * - error: either direction, protocol/runtime error report
 *
 * Every frame carries eventId (dedupe key), epoch (connection generation), seq
 * (monotonic within epoch), and optional cumulative ack. There is no separate
 * ack frame; ack is carried by the header on the next outbound frame.
 * ==========================================================================*/

export const NPC_WIRE_FRAME_TYPES = [
  'session_ready',
  'attach',
  'detach',
  'snapshot',
  'snapshots',
  'decision',
  'decisions',
  'budget',
  'resume',
  'episode_end',
  'heartbeat',
  'error',
] as const;
export type NpcWireFrameType = (typeof NPC_WIRE_FRAME_TYPES)[number];

const WireFrameHeader = {
  v: z.literal(NPC_PROTOCOL_VERSION),
  eventId: BoundedId,
  epoch: WireSeq,
  seq: WireSeq,
  ack: WireSeq.optional(),
} as const;

export const ResumeRequest = z
  .object({
    /** First server frame the client still needs when a scalar stream is used. */
    fromSeq: WireSeq.optional(),
    /** Last cumulatively applied server frame. */
    ack: WireSeq,
    /** Last applied decision per NPC, for replay stores partitioned by NPC. */
    lastDecisionSeq: boundedRecord(WireSeq, NPC_LIMITS.maxSessionNpcs).optional(),
    token: z.string().min(1).max(512).optional(),
  })
  .strict()
  .superRefine((resume, context) => {
    if (resume.fromSeq !== undefined && resume.fromSeq !== resume.ack + 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fromSeq'],
        message: 'fromSeq must equal ack + 1',
      });
    }
  });
export type ResumeRequest = z.infer<typeof ResumeRequest>;

export const NpcSessionReadyFrame = z
  .object({
    /** Canonical WS type: session_ready. */
    type: z.literal('session_ready'),
    ...WireFrameHeader,
    sessionId: BoundedId,
    resumeToken: BoundedId.optional(),
  })
  .strict();
export type NpcSessionReadyFrame = z.infer<typeof NpcSessionReadyFrame>;

export const NpcAttachFrame = z
  .object({
    type: z.literal('attach'),
    ...WireFrameHeader,
    sessionId: BoundedId,
    binding: NpcSoulBinding,
  })
  .strict();
export type NpcAttachFrame = z.infer<typeof NpcAttachFrame>;

export const NpcDetachFrame = z
  .object({
    type: z.literal('detach'),
    ...WireFrameHeader,
    sessionId: BoundedId,
    npcId: BoundedId,
    reason: z.string().min(1).max(NPC_LIMITS.textLength).optional(),
  })
  .strict();
export type NpcDetachFrame = z.infer<typeof NpcDetachFrame>;

const NpcSnapshotFrameBase = z
  .object({
    /** Canonical WS type: snapshot. */
    type: z.literal('snapshot'),
    ...WireFrameHeader,
    snapshot: PerceptionSnapshot,
  })
  .strict();

function validateSnapshotFrame(
  frame: z.infer<typeof NpcSnapshotFrameBase>,
  context: z.RefinementCtx,
): void {
  if (frame.eventId !== frame.snapshot.eventId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['snapshot', 'eventId'],
      message: 'snapshot frame eventId must equal snapshot.eventId',
    });
  }
}

export const NpcSnapshotFrame = NpcSnapshotFrameBase.superRefine(validateSnapshotFrame);
export type NpcSnapshotFrame = z.infer<typeof NpcSnapshotFrame>;

export const NpcSnapshotsFrame = z
  .object({
    type: z.literal('snapshots'),
    ...WireFrameHeader,
    snapshots: z.array(PerceptionSnapshot).min(1).max(NPC_LIMITS.maxBatchSize),
  })
  .strict();
export type NpcSnapshotsFrame = z.infer<typeof NpcSnapshotsFrame>;

export const NpcDecisionFrame = z
  .object({
    /** Canonical WS type: decision. */
    type: z.literal('decision'),
    ...WireFrameHeader,
    decision: NpcDecisionWire,
  })
  .strict();
export type NpcDecisionFrame = z.infer<typeof NpcDecisionFrame>;

export const NpcDecisionsFrame = z
  .object({
    type: z.literal('decisions'),
    ...WireFrameHeader,
    decisions: z.array(NpcDecisionWire).min(1).max(NPC_LIMITS.maxBatchSize),
  })
  .strict();
export type NpcDecisionsFrame = z.infer<typeof NpcDecisionsFrame>;

export const NpcBudgetFrame = z
  .object({
    type: z.literal('budget'),
    ...WireFrameHeader,
    budget: NpcBudgetState,
  })
  .strict();
export type NpcBudgetFrame = z.infer<typeof NpcBudgetFrame>;

export const NpcResumeFrame = z
  .object({
    /** Canonical WS type: resume. */
    type: z.literal('resume'),
    ...WireFrameHeader,
    sessionId: BoundedId,
    resume: ResumeRequest,
  })
  .strict();
export type NpcResumeFrame = z.infer<typeof NpcResumeFrame>;

export const NpcEpisodeEndFrame = z
  .object({
    /** Canonical WS type: episode_end. */
    type: z.literal('episode_end'),
    ...WireFrameHeader,
    sessionId: BoundedId,
    reason: z.string().min(1).max(NPC_LIMITS.textLength).optional(),
  })
  .strict();
export type NpcEpisodeEndFrame = z.infer<typeof NpcEpisodeEndFrame>;

export const NpcHeartbeatFrame = z
  .object({
    /** Canonical WS type: heartbeat. */
    type: z.literal('heartbeat'),
    ...WireFrameHeader,
  })
  .strict();
export type NpcHeartbeatFrame = z.infer<typeof NpcHeartbeatFrame>;

export const NpcErrorFrame = z
  .object({
    /** Canonical WS type: error. */
    type: z.literal('error'),
    ...WireFrameHeader,
    code: BoundedId,
    message: z.string().min(1).max(NPC_LIMITS.textLength),
  })
  .strict();
export type NpcErrorFrame = z.infer<typeof NpcErrorFrame>;

export const NpcWireEnvelope = z
  .discriminatedUnion('type', [
    NpcSessionReadyFrame,
    NpcAttachFrame,
    NpcDetachFrame,
    NpcSnapshotFrameBase,
    NpcSnapshotsFrame,
    NpcDecisionFrame,
    NpcDecisionsFrame,
    NpcBudgetFrame,
    NpcResumeFrame,
    NpcEpisodeEndFrame,
    NpcHeartbeatFrame,
    NpcErrorFrame,
  ])
  .superRefine((frame, context) => {
    if (frame.type === 'snapshot') validateSnapshotFrame(frame, context);
  });
export type NpcWireEnvelope = z.infer<typeof NpcWireEnvelope>;
export type NpcWireEnvelopeType = NpcWireEnvelope['type'];

/* Schema aliases match the lower-camel naming used by existing Brain code. */
export const affordanceParamSchema = AffordanceParam;
export const affordanceSchema = Affordance;
export const perceptionSnapshotSchema = PerceptionSnapshot;
export const npcDecisionWireSchema = NpcDecisionWire;
export const npcDecisionDeadlineSchema = NpcDecisionDeadline;
export const npcSoulBindingSchema = NpcSoulBinding;
export const npcSessionRequestSchema = NpcSessionRequest;
export const npcSessionGrantSchema = NpcSessionGrant;
export const npcSessionResponseSchema = NpcSessionResponse;
export const npcBudgetStateSchema = NpcBudgetState;
export const npcEpisodeSummarySchema = NpcEpisodeSummary;
export const npcSessionReadyFrameSchema = NpcSessionReadyFrame;
export const npcAttachFrameSchema = NpcAttachFrame;
export const npcDetachFrameSchema = NpcDetachFrame;
export const npcSnapshotFrameSchema = NpcSnapshotFrame;
export const npcSnapshotsFrameSchema = NpcSnapshotsFrame;
export const npcDecisionFrameSchema = NpcDecisionFrame;
export const npcDecisionsFrameSchema = NpcDecisionsFrame;
export const npcBudgetFrameSchema = NpcBudgetFrame;
export const npcResumeFrameSchema = NpcResumeFrame;
export const npcEpisodeEndFrameSchema = NpcEpisodeEndFrame;
export const npcHeartbeatFrameSchema = NpcHeartbeatFrame;
export const npcErrorFrameSchema = NpcErrorFrame;
export const npcWireEnvelopeSchema = NpcWireEnvelope;

export const parseAffordance = (value: unknown): Affordance => Affordance.parse(value);
export const safeParseAffordance = (value: unknown) => Affordance.safeParse(value);
export const parsePerceptionSnapshot = (value: unknown): PerceptionSnapshot =>
  PerceptionSnapshot.parse(value);
export const safeParsePerceptionSnapshot = (value: unknown) => PerceptionSnapshot.safeParse(value);
export const parseNpcDecisionWire = (value: unknown): NpcDecisionWire => NpcDecisionWire.parse(value);
export const safeParseNpcDecisionWire = (value: unknown) => NpcDecisionWire.safeParse(value);
export const parseNpcDecisionDeadline = (value: unknown): NpcDecisionDeadline =>
  NpcDecisionDeadline.parse(value);
export const safeParseNpcDecisionDeadline = (value: unknown) => NpcDecisionDeadline.safeParse(value);
export const parseNpcSoulBinding = (value: unknown): NpcSoulBinding => NpcSoulBinding.parse(value);
export const safeParseNpcSoulBinding = (value: unknown) => NpcSoulBinding.safeParse(value);
export const parseNpcSessionRequest = (value: unknown): NpcSessionRequest => NpcSessionRequest.parse(value);
export const safeParseNpcSessionRequest = (value: unknown) => NpcSessionRequest.safeParse(value);
export const parseNpcSessionGrant = (value: unknown): NpcSessionGrant => NpcSessionGrant.parse(value);
export const safeParseNpcSessionGrant = (value: unknown) => NpcSessionGrant.safeParse(value);
export const parseNpcSessionResponse = (value: unknown): NpcSessionResponse => NpcSessionResponse.parse(value);
export const safeParseNpcSessionResponse = (value: unknown) => NpcSessionResponse.safeParse(value);
export const parseNpcBudgetState = (value: unknown): NpcBudgetState => NpcBudgetState.parse(value);
export const safeParseNpcBudgetState = (value: unknown) => NpcBudgetState.safeParse(value);
export const parseNpcEpisodeSummary = (value: unknown): NpcEpisodeSummary => NpcEpisodeSummary.parse(value);
export const safeParseNpcEpisodeSummary = (value: unknown) => NpcEpisodeSummary.safeParse(value);
export const parseNpcSessionReadyFrame = (value: unknown): NpcSessionReadyFrame =>
  NpcSessionReadyFrame.parse(value);
export const parseNpcAttachFrame = (value: unknown): NpcAttachFrame => NpcAttachFrame.parse(value);
export const safeParseNpcAttachFrame = (value: unknown) => NpcAttachFrame.safeParse(value);
export const parseNpcDetachFrame = (value: unknown): NpcDetachFrame => NpcDetachFrame.parse(value);
export const safeParseNpcDetachFrame = (value: unknown) => NpcDetachFrame.safeParse(value);
export const safeParseNpcSessionReadyFrame = (value: unknown) => NpcSessionReadyFrame.safeParse(value);
export const parseNpcSnapshotFrame = (value: unknown): NpcSnapshotFrame => NpcSnapshotFrame.parse(value);
export const safeParseNpcSnapshotFrame = (value: unknown) => NpcSnapshotFrame.safeParse(value);
export const parseNpcSnapshotsFrame = (value: unknown): NpcSnapshotsFrame => NpcSnapshotsFrame.parse(value);
export const safeParseNpcSnapshotsFrame = (value: unknown) => NpcSnapshotsFrame.safeParse(value);
export const parseNpcDecisionFrame = (value: unknown): NpcDecisionFrame => NpcDecisionFrame.parse(value);
export const safeParseNpcDecisionFrame = (value: unknown) => NpcDecisionFrame.safeParse(value);
export const parseNpcDecisionsFrame = (value: unknown): NpcDecisionsFrame => NpcDecisionsFrame.parse(value);
export const safeParseNpcDecisionsFrame = (value: unknown) => NpcDecisionsFrame.safeParse(value);
export const parseNpcBudgetFrame = (value: unknown): NpcBudgetFrame => NpcBudgetFrame.parse(value);
export const safeParseNpcBudgetFrame = (value: unknown) => NpcBudgetFrame.safeParse(value);
export const parseNpcResumeFrame = (value: unknown): NpcResumeFrame => NpcResumeFrame.parse(value);
export const safeParseNpcResumeFrame = (value: unknown) => NpcResumeFrame.safeParse(value);
export const parseNpcEpisodeEndFrame = (value: unknown): NpcEpisodeEndFrame =>
  NpcEpisodeEndFrame.parse(value);
export const safeParseNpcEpisodeEndFrame = (value: unknown) => NpcEpisodeEndFrame.safeParse(value);
export const parseNpcHeartbeatFrame = (value: unknown): NpcHeartbeatFrame => NpcHeartbeatFrame.parse(value);
export const safeParseNpcHeartbeatFrame = (value: unknown) => NpcHeartbeatFrame.safeParse(value);
export const parseNpcErrorFrame = (value: unknown): NpcErrorFrame => NpcErrorFrame.parse(value);
export const safeParseNpcErrorFrame = (value: unknown) => NpcErrorFrame.safeParse(value);
export const parseNpcWireEnvelope = (value: unknown): NpcWireEnvelope => NpcWireEnvelope.parse(value);
export const safeParseNpcWireEnvelope = (value: unknown) => NpcWireEnvelope.safeParse(value);
export const isNpcDecisionWire = (value: unknown): value is NpcDecisionWire =>
  NpcDecisionWire.safeParse(value).success;
export const isNpcWireEnvelope = (value: unknown): value is NpcWireEnvelope =>
  NpcWireEnvelope.safeParse(value).success;

/**
 * JSON Schema projections are generated from the Zod SSOT at module load. They
 * exist for MCP/tool surfaces that cannot consume Zod directly.
 */
function jsonSchemaOf(schema: z.ZodTypeAny, name: string): Record<string, unknown> {
  return zodToJsonSchema(schema, { name, $refStrategy: 'none' }) as Record<string, unknown>;
}

export const npcJsonSchemas = Object.freeze({
  perceptionSnapshot: jsonSchemaOf(PerceptionSnapshot, 'PerceptionSnapshot'),
  decisionWire: jsonSchemaOf(NpcDecisionWire, 'NpcDecisionWire'),
  decisionDeadline: jsonSchemaOf(NpcDecisionDeadline, 'NpcDecisionDeadline'),
  soulBinding: jsonSchemaOf(NpcSoulBinding, 'NpcSoulBinding'),
  sessionRequest: jsonSchemaOf(NpcSessionRequest, 'NpcSessionRequest'),
  sessionGrant: jsonSchemaOf(NpcSessionGrant, 'NpcSessionGrant'),
  sessionResponse: jsonSchemaOf(NpcSessionResponse, 'NpcSessionResponse'),
  budgetState: jsonSchemaOf(NpcBudgetState, 'NpcBudgetState'),
  episodeSummary: jsonSchemaOf(NpcEpisodeSummary, 'NpcEpisodeSummary'),
  wireEnvelope: jsonSchemaOf(NpcWireEnvelope, 'NpcWireEnvelope'),
});

export function isReplayWindowInBounds(fromSeq: number, currentSeq: number): boolean {
  if (!Number.isInteger(fromSeq) || !Number.isInteger(currentSeq)) return false;
  if (fromSeq < 0 || currentSeq < 0 || fromSeq > currentSeq) return false;
  return currentSeq - fromSeq <= NPC_LIMITS.maxResumeReplay;
}
