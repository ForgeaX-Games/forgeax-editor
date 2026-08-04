import { describe, expect, test } from 'bun:test';
import { NPC_TOOL_CONTRACTS } from './npc-tools';

describe('NPC adoption tool contracts', () => {
  test('validates soul_create model preferences and dotted ids', () => {
    expect(NPC_TOOL_CONTRACTS.soul_create.input.parse({
      soulId: 'village.guide',
      name: 'Village Guide',
      identity: 'A patient local guide.',
      models: ['fast-model', 'fallback-model'],
    })).toMatchObject({ soulId: 'village.guide' });
    expect(NPC_TOOL_CONTRACTS.soul_create.input.safeParse({
      soulId: '../guide',
      name: 'Guide',
      identity: 'Unsafe.',
    }).success).toBe(false);
  });

  test('validates npc_wire against canonical affordances', () => {
    const input = {
      game: 'village',
      npcId: 'guide',
      soulId: 'village.guide',
      decisionDeadline: { preset: 'patient' },
      affordances: [
        { action: 'goto', params: { target: { type: 'enum', source: 'waypoint' } } },
      ],
    } as const;
    const parsed = NPC_TOOL_CONTRACTS.npc_wire.input.parse(input);
    expect(parsed.game).toBe('village');
    expect(parsed.decisionDeadline).toEqual({ preset: 'patient' });
    expect(parsed.affordances[0]?.params?.target).toEqual({ type: 'enum', source: 'waypoint' });
    expect(NPC_TOOL_CONTRACTS.npc_wire.input.safeParse({
      ...input,
      affordances: [{ action: 'goto', params: { target: 'enum:waypoint' } }],
    }).success).toBe(false);
  });

  test('supports deadline presets, custom values, and the implicit default', () => {
    const base = {
      game: 'village',
      npcId: 'guide',
      soulId: 'village.guide',
      affordances: [{ action: 'wave' }],
    };
    expect(NPC_TOOL_CONTRACTS.npc_wire.input.parse(base).decisionDeadline).toBeUndefined();
    for (const preset of ['fast', 'balanced', 'patient'] as const) {
      expect(NPC_TOOL_CONTRACTS.npc_wire.input.safeParse({
        ...base,
        decisionDeadline: { preset },
      }).success).toBe(true);
    }
    expect(NPC_TOOL_CONTRACTS.npc_wire.input.safeParse({
      ...base,
      decisionDeadline: { preset: 'custom', timeoutMs: 15_000 },
    }).success).toBe(true);
    expect(NPC_TOOL_CONTRACTS.npc_wire.input.safeParse({
      ...base,
      decisionDeadline: { preset: 'custom', timeoutMs: 999 },
    }).success).toBe(false);
    expect(NPC_TOOL_CONTRACTS.npc_wire.input.safeParse({
      ...base,
      decisionDeadline: { preset: 'custom', timeoutMs: 30_001 },
    }).success).toBe(false);
  });

  test('rejects malformed wire requests with stable validation failure input', () => {
    const valid = {
      game: 'village',
      npcId: 'guide',
      soulId: 'village.guide',
      affordances: [{ action: 'goto', params: { target: { type: 'enum', source: 'waypoint' } } }],
    };
    const malformed = [
      {},
      { ...valid, game: '' },
      { ...valid, game: '../village' },
      { ...valid, npcId: '' },
      { ...valid, npcId: '../guide' },
      { ...valid, soulId: '' },
      { ...valid, soulId: '../guide' },
      { ...valid, affordances: [] },
      { ...valid, affordances: [{ params: {} }] },
      { ...valid, affordances: [{ action: 'goto', params: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`p${index}`, { type: 'enum', source: 'waypoint' }])) }] },
      { ...valid, affordances: [{ action: 'goto', params: { target: 'waypoint' } }] },
      { ...valid, affordances: [{ action: 'goto', params: { target: { type: 'enum' } } }] },
      { ...valid, affordances: [{ action: 'follow', params: { target: { type: 'number', source: 'x' } } }] },
      { ...valid, affordances: [{ action: 'emote', params: { mood: 1 } }] },
      { ...valid, affordances: [{ action: 'goto', params: { target: { type: 'enum', source: 'waypoint' } } }], extra: true },
      { ...valid, extra: true },
      { ...valid, npcId: 'a'.repeat(129) },
      { ...valid, soulId: 'a'.repeat(129) },
      { ...valid, game: 'a'.repeat(129) },
      { ...valid, affordances: Array.from({ length: 65 }, () => valid.affordances[0]) },
      { ...valid, affordances: null },
    ];
    expect(malformed).toHaveLength(21);
    for (const candidate of malformed) {
      expect(NPC_TOOL_CONTRACTS.npc_wire.input.safeParse(candidate).success).toBe(false);
    }
  });
});
