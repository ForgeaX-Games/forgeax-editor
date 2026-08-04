import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npcJsonSchemas } from '../src/npc-protocol';
import { NPC_TOOL_CONTRACTS } from '../src/npc-tools';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaRoot = process.env.NPC_SCHEMA_OUTPUT_DIR ?? join(packageRoot, 'schemas', 'npc');

const schemas = {
  'budget-state.schema.json': npcJsonSchemas.budgetState,
  'decision-deadline.schema.json': npcJsonSchemas.decisionDeadline,
  'decision-wire.schema.json': npcJsonSchemas.decisionWire,
  'episode-summary.schema.json': npcJsonSchemas.episodeSummary,
  'perception-snapshot.schema.json': npcJsonSchemas.perceptionSnapshot,
  'session-grant.schema.json': npcJsonSchemas.sessionGrant,
  'session-request.schema.json': npcJsonSchemas.sessionRequest,
  'session-response.schema.json': npcJsonSchemas.sessionResponse,
  'soul-binding.schema.json': npcJsonSchemas.soulBinding,
  'wire-envelope.schema.json': npcJsonSchemas.wireEnvelope,
  'tool-npc-wire-input.schema.json': NPC_TOOL_CONTRACTS.npc_wire.inputSchema,
  'tool-soul-create-input.schema.json': NPC_TOOL_CONTRACTS.soul_create.inputSchema,
} as const;

mkdirSync(schemaRoot, { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  writeFileSync(join(schemaRoot, name), `${JSON.stringify(schema, null, 2)}\n`);
}

console.log(`[npc-schema] wrote ${Object.keys(schemas).length} artifacts to schemas/npc`);
