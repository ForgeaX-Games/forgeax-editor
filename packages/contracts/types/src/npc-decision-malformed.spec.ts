import { describe, expect, test } from 'bun:test';
import { NPC_LIMITS, NPC_PROTOCOL_VERSION, safeParseNpcDecisionWire } from './npc-protocol';

const base = {
  v: NPC_PROTOCOL_VERSION,
  npcId: 'guide',
  seq: 1,
  intent: { action: 'idle', ttlSec: 10 },
  utterance: { lines: ['Hello.'] },
  emotion: { mood: 'calm', towards: { player: 0.5 } },
};

const tooManyParams = Object.fromEntries(
  Array.from({ length: NPC_LIMITS.maxIntentParams + 1 }, (_, index) => [`p${index}`, 'value']),
);
const tooManyTargets = Object.fromEntries(
  Array.from({ length: NPC_LIMITS.maxEmotionTargets + 1 }, (_, index) => [`p${index}`, 0]),
);

const malformedDecisions: ReadonlyArray<readonly [string, unknown]> = [
  ['missing version', { ...base, v: undefined }],
  ['future version', { ...base, v: NPC_PROTOCOL_VERSION + 1 }],
  ['missing npcId', { ...base, npcId: undefined }],
  ['empty npcId', { ...base, npcId: '' }],
  ['npcId containing spaces', { ...base, npcId: 'village guide' }],
  ['missing sequence', { ...base, seq: undefined }],
  ['zero sequence', { ...base, seq: 0 }],
  ['fractional sequence', { ...base, seq: 1.5 }],
  ['oversized sequence', { ...base, seq: NPC_LIMITS.maxWireSeq + 1 }],
  ['memory operation leakage', { ...base, memoryOps: [] }],
  ['unknown top-level field', { ...base, reasoning: 'private chain of thought' }],
  ['non-object intent', { ...base, intent: 'idle' }],
  ['empty intent action', { ...base, intent: { action: '', ttlSec: 10 } }],
  ['missing intent ttl', { ...base, intent: { action: 'idle' } }],
  ['zero intent ttl', { ...base, intent: { action: 'idle', ttlSec: 0 } }],
  ['fractional intent ttl', { ...base, intent: { action: 'idle', ttlSec: 1.5 } }],
  ['oversized intent ttl', { ...base, intent: { action: 'idle', ttlSec: NPC_LIMITS.maxIntentTtlSec + 1 } }],
  ['non-string intent parameter', { ...base, intent: { action: 'idle', ttlSec: 10, params: { target: 1 } } }],
  ['invalid intent parameter key', { ...base, intent: { action: 'idle', ttlSec: 10, params: { 'bad key': 'x' } } }],
  ['too many intent parameters', { ...base, intent: { action: 'idle', ttlSec: 10, params: tooManyParams } }],
  ['unknown intent field', { ...base, intent: { action: 'idle', ttlSec: 10, confidence: 1 } }],
  ['empty utterance lines', { ...base, utterance: { lines: [] } }],
  ['too many utterance lines', { ...base, utterance: { lines: Array(NPC_LIMITS.maxUtteranceLines + 1).fill('line') } }],
  ['empty utterance line', { ...base, utterance: { lines: [''] } }],
  ['overlong utterance line', { ...base, utterance: { lines: ['x'.repeat(NPC_LIMITS.utteranceLineLength + 1)] } }],
  ['unknown utterance field', { ...base, utterance: { lines: ['Hello.'], locale: 'en' } }],
  ['empty emotion mood', { ...base, emotion: { mood: '' } }],
  ['overlong emotion mood', { ...base, emotion: { mood: 'x'.repeat(NPC_LIMITS.moodLength + 1) } }],
  ['emotion outside lower bound', { ...base, emotion: { mood: 'angry', towards: { player: -1.1 } } }],
  ['emotion outside upper bound', { ...base, emotion: { mood: 'excited', towards: { player: 1.1 } } }],
  ['too many emotion targets', { ...base, emotion: { mood: 'busy', towards: tooManyTargets } }],
  ['unknown emotion field', { ...base, emotion: { mood: 'calm', confidence: 1 } }],
  ['non-boolean fallback marker', { ...base, fallback: 'yes' }],
];

describe('NpcDecisionWire malformed corpus', () => {
  test('keeps at least 20 independent malformed fixtures', () => {
    expect(malformedDecisions.length).toBeGreaterThanOrEqual(20);
  });

  for (const [name, value] of malformedDecisions) {
    test(`rejects ${name}`, () => {
      expect(safeParseNpcDecisionWire(value).success).toBe(false);
    });
  }
});
