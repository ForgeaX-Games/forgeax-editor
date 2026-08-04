import { describe, expect, test } from 'bun:test';
import {
  NPC_LIMITS,
  NPC_DECISION_DEADLINE_PRESETS_MS,
  NPC_PROTOCOL_VERSION,
  Affordance,
  NpcDecisionWire,
  NpcWireEnvelope,
  Vec2,
  isNpcDecisionWire,
  isNpcWireEnvelope,
  isReplayWindowInBounds,
  isSupportedNpcProtocolVersion,
  npcJsonSchemas,
  parseAffordance,
  parseNpcAttachFrame,
  parseNpcBudgetFrame,
  parseNpcDecisionFrame,
  parseNpcDecisionDeadline,
  parseNpcDecisionsFrame,
  parseNpcDecisionWire,
  parseNpcDetachFrame,
  parseNpcEpisodeEndFrame,
  parseNpcEpisodeSummary,
  parseNpcErrorFrame,
  parseNpcHeartbeatFrame,
  parseNpcResumeFrame,
  parseNpcSessionReadyFrame,
  parseNpcSnapshotFrame,
  parseNpcSnapshotsFrame,
  parseNpcWireEnvelope,
  parsePerceptionSnapshot,
  resolveNpcDecisionDeadlineMs,
  safeParseNpcDecisionFrame,
  safeParseNpcDecisionDeadline,
  safeParseNpcDecisionWire,
  safeParseNpcHeartbeatFrame,
  safeParseNpcWireEnvelope,
  safeParsePerceptionSnapshot,
} from './npc-protocol';

const arbitraryAffordance = {
  action: 'game.summon_fireflies',
  params: {
    destination: { type: 'enum' as const, source: 'waypoint' as const },
    companion: { type: 'enum' as const, source: 'nearby.id' as const },
    color: {
      type: 'enum' as const,
      source: 'literal' as const,
      values: ['blue', 'gold'],
    },
  },
};

const snapshot = {
  v: NPC_PROTOCOL_VERSION,
  eventId: 'evt-100',
  game: 'firefly-village',
  npcId: 'npc-42',
  t: 12.5,
  trigger: 'player_message' as const,
  playerId: 'player-1',
  text: 'Show me something magical.',
  self: { pos: { x: 0, y: 0 }, activity: 'watching the pond', mood: 'curious' },
  nearby: [
    { kind: 'player', id: 'player-1', pos: { x: 2, y: 1 }, facts: ['wears a red cloak'] },
  ],
  events: [{ type: 'weather.changed', weather: 'clear', temperature: 18 }],
  affordances: [arbitraryAffordance, { action: 'game.wait' }],
  recentEvents: ['player-1 arrived'],
  scene: 'village-square',
  visibilityGroup: 'public',
};

const decision = {
  v: NPC_PROTOCOL_VERSION,
  npcId: 'npc-42',
  seq: 7,
  intent: {
    action: 'game.summon_fireflies',
    params: { destination: 'pond', companion: 'player-1', color: 'gold' },
    ttlSec: 15,
  },
  utterance: { lines: ['Watch the water closely.'] },
  emotion: { mood: 'delighted', towards: { 'player-1': 0.6 } },
};

const header = { v: NPC_PROTOCOL_VERSION, eventId: 'wire-1', epoch: 2, seq: 8, ack: 7 };

function expectProtocolRoundTrip(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected);
}

const canonicalFrames = {
  session_ready: {
    type: 'session_ready',
    ...header,
    sessionId: 'session-1',
    resumeToken: 'resume-token-next',
  },
  attach: {
    type: 'attach',
    ...header,
    sessionId: 'session-1',
    binding: { npcId: 'npc-42', soulId: 'firefly-village.guide' },
  },
  detach: {
    type: 'detach',
    ...header,
    sessionId: 'session-1',
    npcId: 'npc-42',
    reason: 'left visibility range',
  },
  snapshot: {
    type: 'snapshot',
    ...header,
    eventId: snapshot.eventId,
    snapshot,
  },
  snapshots: {
    type: 'snapshots',
    ...header,
    snapshots: [snapshot],
  },
  decision: {
    type: 'decision',
    ...header,
    decision,
  },
  decisions: {
    type: 'decisions',
    ...header,
    decisions: [decision],
  },
  budget: {
    type: 'budget',
    ...header,
    budget: { limit: 60, used: 7, remaining: 53, resetsAt: 60_000 },
  },
  resume: {
    type: 'resume',
    ...header,
    sessionId: 'session-1',
    resume: { fromSeq: 6, ack: 5, lastDecisionSeq: { 'npc-42': 4 }, token: 'resume-token' },
  },
  episode_end: {
    type: 'episode_end',
    ...header,
    sessionId: 'session-1',
    reason: 'player left the village',
  },
  heartbeat: {
    type: 'heartbeat',
    ...header,
  },
  error: {
    type: 'error',
    ...header,
    code: 'bad_seq',
    message: 'gap detected',
  },
};

describe('NPC protocol version', () => {
  test('accepts only the current literal version', () => {
    expect(isSupportedNpcProtocolVersion(NPC_PROTOCOL_VERSION)).toBe(true);
    expect(isSupportedNpcProtocolVersion(NPC_PROTOCOL_VERSION + 1)).toBe(false);
    expect(isSupportedNpcProtocolVersion('1')).toBe(false);
  });
});

describe('NPC decision deadline', () => {
  test('resolves the implicit default, presets, and custom deadline', () => {
    expect(resolveNpcDecisionDeadlineMs()).toBe(NPC_DECISION_DEADLINE_PRESETS_MS.balanced);
    expect(resolveNpcDecisionDeadlineMs(parseNpcDecisionDeadline({ preset: 'fast' })))
      .toBe(NPC_DECISION_DEADLINE_PRESETS_MS.fast);
    expect(resolveNpcDecisionDeadlineMs(parseNpcDecisionDeadline({ preset: 'patient' })))
      .toBe(NPC_DECISION_DEADLINE_PRESETS_MS.patient);
    expect(resolveNpcDecisionDeadlineMs(parseNpcDecisionDeadline({
      preset: 'custom',
      timeoutMs: 15_000,
    }))).toBe(15_000);
  });

  test('rejects ambiguous and out-of-range deadline configuration', () => {
    expect(safeParseNpcDecisionDeadline({ preset: 'balanced', timeoutMs: 7_000 }).success).toBe(false);
    expect(safeParseNpcDecisionDeadline({ preset: 'custom' }).success).toBe(false);
    expect(safeParseNpcDecisionDeadline({ preset: 'custom', timeoutMs: 999 }).success).toBe(false);
    expect(safeParseNpcDecisionDeadline({ preset: 'custom', timeoutMs: 30_001 }).success).toBe(false);
    expect(safeParseNpcDecisionDeadline({ preset: 'slow' }).success).toBe(false);
  });
});

describe('generic Affordance', () => {
  test('accepts an arbitrary game-defined action without a contracts registry', () => {
    expect(parseAffordance(arbitraryAffordance)).toEqual(arbitraryAffordance);
    expect(Affordance.safeParse({ action: 'another_game.completely_new_action' }).success).toBe(true);
  });

  test('supports the three typed enum sources', () => {
    expect(
      Affordance.safeParse({
        action: 'custom.action',
        params: {
          a: { type: 'enum', source: 'waypoint' },
          b: { type: 'enum', source: 'nearby.id' },
          c: { type: 'enum', source: 'literal', values: ['one'] },
        },
      }).success,
    ).toBe(true);
  });

  test('rejects an unknown parameter source and malformed literals', () => {
    expect(
      Affordance.safeParse({
        action: 'custom.action',
        params: { p: { type: 'enum', source: 'inventory' } },
      }).success,
    ).toBe(false);
    expect(
      Affordance.safeParse({
        action: 'custom.action',
        params: { p: { type: 'enum', source: 'literal', values: [] } },
      }).success,
    ).toBe(false);
  });

  test('rejects invalid affordance params and literal bounds', () => {
    expect(
      Affordance.safeParse({
        action: 'custom.action',
        params: { p: { type: 'enum', source: 'literal', values: ['x'.repeat(65)] } },
      }).success,
    ).toBe(false);
    expect(
      Affordance.safeParse({
        action: 'custom.action',
        params: {
          p: {
            type: 'enum',
            source: 'literal',
            values: Array.from({ length: NPC_LIMITS.maxLiteralValues + 1 }, (_, i) => `v${i}`),
          },
        },
      }).success,
    ).toBe(false);
    expect(
      Affordance.safeParse({
        action: 'custom.action',
        params: { p: { type: 'enum', source: 'waypoint', values: ['hallucinated'] } },
      }).success,
    ).toBe(false);
  });

  test('bounds parameter count and rejects unknown top-level keys', () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: NPC_LIMITS.maxAffordanceParams + 1 }, (_, i) => [
        `p${i}`,
        { type: 'enum', source: 'waypoint' },
      ]),
    );
    expect(Affordance.safeParse({ action: 'custom.action', params: tooMany }).success).toBe(false);
    expect(Affordance.safeParse({ action: 'custom.action', kind: 'closed-enum-leak' }).success).toBe(false);
  });
});

describe('PerceptionSnapshot PRD shape', () => {
  test('accepts v/eventId/game/npcId/t/trigger/self/nearby/events/affordances', () => {
    expect(parsePerceptionSnapshot(snapshot)).toEqual(snapshot);
  });

  test('rejects overlong player text', () => {
    expect(safeParsePerceptionSnapshot({ ...snapshot, text: 'x'.repeat(NPC_LIMITS.textLength + 1) }).success).toBe(
      false,
    );
  });

  test('validates vectors, event scalar values, and strict top-level shape', () => {
    expect(Vec2.safeParse({ x: 0, y: Number.NaN }).success).toBe(false);
    expect(safeParsePerceptionSnapshot({ ...snapshot, events: [{ type: 'bad', nested: {} }] }).success).toBe(false);
    expect(safeParsePerceptionSnapshot({ ...snapshot, unknown: true }).success).toBe(false);
  });

  test('enforces nearby, events, affordance, and fact bounds', () => {
    expect(
      safeParsePerceptionSnapshot({
        ...snapshot,
        nearby: Array.from({ length: NPC_LIMITS.maxNearby + 1 }, (_, i) => ({
          kind: 'thing',
          id: `e${i}`,
          pos: { x: 0, y: 0 },
          facts: [],
        })),
      }).success,
    ).toBe(false);
    expect(
      safeParsePerceptionSnapshot({
        ...snapshot,
        events: Array.from({ length: NPC_LIMITS.maxEvents + 1 }, () => ({ type: 'tick' })),
      }).success,
    ).toBe(false);
    expect(
      safeParsePerceptionSnapshot({
        ...snapshot,
        affordances: Array.from({ length: NPC_LIMITS.maxAffordances + 1 }, (_, i) => ({ action: `a${i}` })),
      }).success,
    ).toBe(false);
    expect(
      safeParsePerceptionSnapshot({
        ...snapshot,
        nearby: [{ ...snapshot.nearby[0], facts: Array(NPC_LIMITS.maxNearbyFacts + 1).fill('fact') }],
      }).success,
    ).toBe(false);
  });

  test('requires current version, bounded identifiers, and nonnegative finite time', () => {
    expect(safeParsePerceptionSnapshot({ ...snapshot, v: 2 }).success).toBe(false);
    expect(safeParsePerceptionSnapshot({ ...snapshot, eventId: 'has spaces' }).success).toBe(false);
    expect(safeParsePerceptionSnapshot({ ...snapshot, t: -1 }).success).toBe(false);
  });
});

describe('NpcDecisionWire PRD shape', () => {
  test('accepts v/npcId/seq with intent, utterance, and emotion', () => {
    expect(parseNpcDecisionWire(decision)).toEqual(decision);
  });

  test('allows arbitrary intent actions declared by the game', () => {
    expect(
      safeParseNpcDecisionWire({
        v: NPC_PROTOCOL_VERSION,
        npcId: 'npc-1',
        seq: 1,
        intent: { action: 'future_game.action_added_tomorrow', ttlSec: 1 },
      }).success,
    ).toBe(true);
  });

  test('NEVER accepts memoryOps on the public wire', () => {
    const leaked = { ...decision, memoryOps: [{ kind: 'episode', text: 'secret', sourceEventId: 'evt-100' }] };
    expect(safeParseNpcDecisionWire(leaked).success).toBe(false);
    expect(isNpcDecisionWire(leaked)).toBe(false);
  });

  test('enforces decision bounds', () => {
    expect(safeParseNpcDecisionWire({ ...decision, seq: 0 }).success).toBe(false);
    expect(safeParseNpcDecisionWire({ ...decision, seq: NPC_LIMITS.maxWireSeq + 1 }).success).toBe(false);
    expect(
      safeParseNpcDecisionWire({ ...decision, intent: { ...decision.intent, ttlSec: NPC_LIMITS.maxIntentTtlSec + 1 } })
        .success,
    ).toBe(false);
    expect(
      safeParseNpcDecisionWire({
        ...decision,
        utterance: { lines: Array(NPC_LIMITS.maxUtteranceLines + 1).fill('line') },
      }).success,
    ).toBe(false);
    expect(
      safeParseNpcDecisionWire({ ...decision, emotion: { mood: 'x', towards: { someone: 1.1 } } }).success,
    ).toBe(false);
  });

  test('all decision sections are optional, but unknown keys fail closed', () => {
    expect(safeParseNpcDecisionWire({ v: 1, npcId: 'npc-1', seq: 1 }).success).toBe(true);
    expect(safeParseNpcDecisionWire({ v: 1, npcId: 'npc-1', seq: 1, reasoning: 'not in PRD' }).success).toBe(false);
  });

  test('strictly rejects hallucinated unknown fields inside nested decision sections', () => {
    expect(
      NpcDecisionWire.safeParse({
        ...decision,
        intent: { ...decision.intent, privateThought: 'hallucinated' },
      }).success,
    ).toBe(false);
    expect(
      NpcDecisionWire.safeParse({
        ...decision,
        utterance: { ...decision.utterance, locale: 'en-US' },
      }).success,
    ).toBe(false);
    expect(
      NpcDecisionWire.safeParse({
        ...decision,
        emotion: { ...decision.emotion, confidence: 1 },
      }).success,
    ).toBe(false);
  });
});

describe('canonical WebSocket frames', () => {
  test('round-trips every canonical WS frame through only the exported union parser', () => {
    for (const frame of Object.values(canonicalFrames)) {
      expectProtocolRoundTrip(parseNpcWireEnvelope(frame), frame);
      expect(NpcWireEnvelope.safeParse(frame).success).toBe(true);
      expect(isNpcWireEnvelope(frame)).toBe(true);
    }
  });

  test('exports per-frame parse helpers for every canonical WS frame type', () => {
    expectProtocolRoundTrip(parseNpcSessionReadyFrame(canonicalFrames.session_ready), canonicalFrames.session_ready);
    expectProtocolRoundTrip(parseNpcAttachFrame(canonicalFrames.attach), canonicalFrames.attach);
    expectProtocolRoundTrip(parseNpcDetachFrame(canonicalFrames.detach), canonicalFrames.detach);
    expectProtocolRoundTrip(parseNpcSnapshotFrame(canonicalFrames.snapshot), canonicalFrames.snapshot);
    expectProtocolRoundTrip(parseNpcSnapshotsFrame(canonicalFrames.snapshots), canonicalFrames.snapshots);
    expectProtocolRoundTrip(parseNpcDecisionFrame(canonicalFrames.decision), canonicalFrames.decision);
    expectProtocolRoundTrip(parseNpcDecisionsFrame(canonicalFrames.decisions), canonicalFrames.decisions);
    expectProtocolRoundTrip(parseNpcBudgetFrame(canonicalFrames.budget), canonicalFrames.budget);
    expectProtocolRoundTrip(parseNpcResumeFrame(canonicalFrames.resume), canonicalFrames.resume);
    expectProtocolRoundTrip(parseNpcEpisodeEndFrame(canonicalFrames.episode_end), canonicalFrames.episode_end);
    expectProtocolRoundTrip(parseNpcHeartbeatFrame(canonicalFrames.heartbeat), canonicalFrames.heartbeat);
    expectProtocolRoundTrip(parseNpcErrorFrame(canonicalFrames.error), canonicalFrames.error);
  });

  test('uses the chosen PRD names and rejects drifted legacy frame names', () => {
    expect(safeParseNpcWireEnvelope({ ...canonicalFrames.session_ready, type: 'hello' }).success).toBe(false);
    expect(safeParseNpcWireEnvelope({ ...canonicalFrames.snapshot, type: 'perception' }).success).toBe(false);
    expect(safeParseNpcWireEnvelope({ ...canonicalFrames.episode_end, type: 'episode.end' }).success).toBe(false);
    expect(safeParseNpcWireEnvelope({ type: 'session.open', ...header, sessionId: 'session-1' }).success).toBe(false);
    expect(safeParseNpcWireEnvelope({ type: 'ack', ...header, ack: 7 }).success).toBe(false);
  });

  test('requires snapshot frame eventId to equal the idempotency key in its snapshot', () => {
    expect(safeParseNpcWireEnvelope({ ...canonicalFrames.snapshot, eventId: 'wire-1' }).success).toBe(false);
  });

  test('decision frame still blocks memoryOps leakage on the public wire', () => {
    expect(
      safeParseNpcDecisionFrame({
        ...canonicalFrames.decision,
        decision: { ...decision, memoryOps: [] },
      }).success,
    ).toBe(false);
  });

  test('rejects missing idempotency/order fields, hallucinated unknown fields, and invalid counters', () => {
    expect(safeParseNpcHeartbeatFrame({ type: 'heartbeat', v: 1, epoch: 1, seq: 1 }).success).toBe(false);
    expect(safeParseNpcHeartbeatFrame({ ...canonicalFrames.heartbeat, debug: true }).success).toBe(false);
    expect(safeParseNpcHeartbeatFrame({ ...canonicalFrames.heartbeat, epoch: -1 }).success).toBe(false);
    expect(safeParseNpcHeartbeatFrame({ ...canonicalFrames.heartbeat, seq: 1.5 }).success).toBe(false);
    expect(safeParseNpcHeartbeatFrame({ ...canonicalFrames.heartbeat, ack: NPC_LIMITS.maxWireSeq + 1 }).success).toBe(
      false,
    );
  });

  test('bounds resume replay inputs at parse time and by local replay-window helper', () => {
    expect(
      safeParseNpcWireEnvelope({
        ...canonicalFrames.resume,
        resume: { fromSeq: NPC_LIMITS.maxWireSeq + 1 },
      }).success,
    ).toBe(false);
    expect(isReplayWindowInBounds(0, NPC_LIMITS.maxResumeReplay)).toBe(true);
    expect(isReplayWindowInBounds(0, NPC_LIMITS.maxResumeReplay + 1)).toBe(false);
  });

  test('keeps episode summaries server-owned and exports JSON Schema projections', () => {
    expect(parseNpcEpisodeSummary({
      startedAt: 1_000,
      endedAt: 2_000,
      snapshotCount: 4,
      decisionCount: 3,
      fallbackCount: 1,
    }).decisionCount).toBe(3);
    expect(safeParseNpcWireEnvelope({
      ...canonicalFrames.episode_end,
      summary: { startedAt: 1_000, endedAt: 2_000, snapshotCount: 4, decisionCount: 3 },
    }).success).toBe(false);
    expect(npcJsonSchemas.perceptionSnapshot).toHaveProperty('$schema');
    expect(npcJsonSchemas.decisionWire).toHaveProperty('$schema');
    expect(npcJsonSchemas.wireEnvelope).toHaveProperty('$schema');
  });
});

describe('resume replay limit', () => {
  test('accepts bounded windows', () => {
    expect(isReplayWindowInBounds(0, NPC_LIMITS.maxResumeReplay)).toBe(true);
    expect(isReplayWindowInBounds(5, 5)).toBe(true);
  });

  test('rejects oversized, reversed, negative, and fractional windows', () => {
    expect(isReplayWindowInBounds(0, NPC_LIMITS.maxResumeReplay + 1)).toBe(false);
    expect(isReplayWindowInBounds(6, 5)).toBe(false);
    expect(isReplayWindowInBounds(-1, 1)).toBe(false);
    expect(isReplayWindowInBounds(0.5, 1)).toBe(false);
  });
});
