import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  Affordance,
  NPC_LIMITS,
  NpcDecisionDeadline,
} from './npc-protocol';

const SoulCreateInput = z
  .object({
    soulId: z
      .string()
      .trim()
      .min(1)
      .max(NPC_LIMITS.idLength)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u)
      .refine((id) => !id.includes('..'), { message: 'soulId must not contain path traversal' }),
    name: z.string().trim().min(1).max(80),
    identity: z.string().trim().min(1).max(4_000),
    model: z.string().trim().min(1).optional(),
    models: z.union([
      z.string().trim().min(1),
      z.array(z.string().trim().min(1)).min(1),
    ]).optional(),
  })
  .strict();
export type SoulCreateInput = z.infer<typeof SoulCreateInput>;

const NpcWireInput = z
  .object({
    game: z.string().min(1).max(NPC_LIMITS.idLength).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u),
    npcId: z.string().min(1).max(NPC_LIMITS.idLength).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u),
    soulId: z.string().min(1).max(NPC_LIMITS.idLength).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u),
    decisionDeadline: NpcDecisionDeadline.optional(),
    affordances: z.array(Affordance).min(1).max(NPC_LIMITS.maxAffordances),
  })
  .strict();
export type NpcWireInput = z.infer<typeof NpcWireInput>;

function inputSchema(schema: z.ZodTypeAny, name: string): Record<string, unknown> {
  const projected = zodToJsonSchema(schema, { name, $refStrategy: 'none' }) as Record<string, unknown>;
  const definitions = projected.definitions as Record<string, unknown> | undefined;
  return (definitions?.[name] as Record<string, unknown> | undefined) ?? projected;
}

export interface NpcToolContract {
  readonly name: 'soul_create' | 'npc_wire';
  readonly description: string;
  readonly input: z.ZodTypeAny;
  readonly inputSchema: Record<string, unknown>;
}

export const NPC_TOOL_CONTRACTS = Object.freeze({
  soul_create: {
    name: 'soul_create',
    description:
      'Create or update a reusable producer-owned NPC Soul pack. Use a bounded soulId such as <game>.<npc>; keep persona and model preferences out of game code.',
    input: SoulCreateInput,
    inputSchema: inputSchema(SoulCreateInput, 'SoulCreateInput'),
  },
  npc_wire: {
    name: 'npc_wire',
    description:
      'Wire a Soul into a game through @forgeax/npc-client. Declare affordances, sample snapshots at events and low-frequency heartbeats, and execute TTL intents through the game Body.',
    input: NpcWireInput,
    inputSchema: inputSchema(NpcWireInput, 'NpcWireInput'),
  },
} satisfies Record<string, NpcToolContract>);

export { NpcWireInput, SoulCreateInput };
