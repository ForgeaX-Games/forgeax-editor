// schema.ts — GameProjectSchema + GuidString refinement (D-4, D-7)
//
// D-4 fields: id:string / name:string / schemaVersion:string / entry?:string /
// defaultScene?:GuidString / physics?:union(enum+bool) / pointerLock?:bool /
// input?:string / preview?:nested-object. .strict() rejects unknown fields.
//
// D-7: GuidString refinement lives here (engine-project), calls
// AssetGuid.parse from engine-pack, translates PackError to zod error message.

import { z } from 'zod';
import { AssetGuid } from '@forgeax/engine-pack/guid';

// ── GuidString: zod refinement calling AssetGuid.parse (AC-04) ──────────────
export const GuidString = z.string().refine(
  (val) => AssetGuid.parse(val).ok,
  (val) => {
    const parsed = AssetGuid.parse(val);
    const message =
      !parsed.ok ? parsed.error.hint : `invalid GUID: ${val}`;
    return { message };
  },
);

// ── physics union: all 5 known values (D-4) ─────────────────────────────────
const PhysicsUnion = z.union([
  z.enum(['3d', '2d', 'rapier-3d', 'rapier-2d']),
  z.boolean(),
]);

// ── preview.skin nested object (D-4) ────────────────────────────────────────
const SkinSchema = z.object({
  sceneGuid: z.string().optional(),
  clipGuids: z.array(z.string()).optional(),
  clipDefault: z.string().optional(),
  scale: z.number().optional(),
  pos: z.array(z.number()).optional(),
}).passthrough();

const PreviewSchema = z.object({ skin: SkinSchema }).passthrough();

// ── GameProjectSchema: strict zod object (AC-03, AC-05) ─────────────────────
export const GameProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  schemaVersion: z.string(),
  entry: z.string().optional(),
  defaultScene: GuidString.optional(),
  physics: PhysicsUnion.optional(),
  pointerLock: z.boolean().optional(),
  input: z.string().optional(),
  preview: PreviewSchema.optional(),
}).strict();

// ── GameProject type: z.infer-derived (AC-02, AC-05) ────────────────────────
export type GameProject = z.infer<typeof GameProjectSchema>;