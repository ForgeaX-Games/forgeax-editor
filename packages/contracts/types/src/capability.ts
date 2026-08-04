/**
 * Cross-kernel capability contract.
 *
 * The manifest remains the author-facing source of truth. These types describe
 * the runtime projection produced by the orchestrator after origin, trust and
 * generation have been derived from the manifest registry.
 */
import { z } from 'zod';

export const CapabilityKindSchema = z.enum([
  'skill',
  'tool',
  'command',
  'mcp',
  'extension',
  'memory',
]);
export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;

export const CapabilityLifecycleStateSchema = z.enum([
  'load',
  'activate',
  'ready',
  'reload',
  'deactivate',
  'broken',
]);
export type CapabilityLifecycleState = z.infer<typeof CapabilityLifecycleStateSchema>;

export const CapabilityOriginSchema = z.enum(['builtin', 'user', 'project']);
export type CapabilityOrigin = z.infer<typeof CapabilityOriginSchema>;

export const CapabilityTrustTierSchema = z.enum(['own', 'imported']);
export type CapabilityTrustTier = z.infer<typeof CapabilityTrustTierSchema>;

/** Author-facing declarations embedded in `forgeax-extension.json`. */
export const ManifestCommandCapabilitySchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  trigger: z.string().optional(),
  input: z.unknown().optional(),
  permissions: z.array(z.string().min(1)).optional(),
});

export const ManifestMcpCapabilitySchema = z.object({
  id: z.string().min(1),
  transport: z.enum(['stdio', 'http', 'sse']).optional(),
  entry: z.string().optional(),
  requiresRestart: z.boolean().optional(),
  tools: z.array(z.string().min(1)).optional(),
});

export const ManifestMemoryCapabilitySchema = z.object({
  id: z.string().min(1),
  memoryTiers: z.array(z.enum(['identity', 'traits', 'episodes'])).optional(),
  read: z.boolean().optional(),
  write: z.boolean().optional(),
});

export const CapabilityIsolationSchema = z.object({
  project: z.boolean().default(true),
  agent: z.boolean().default(true),
  session: z.boolean().default(true),
  thread: z.boolean().default(true),
  memoryTiers: z.array(z.enum(['identity', 'traits', 'episodes'])).default([]),
});
export type CapabilityIsolation = z.infer<typeof CapabilityIsolationSchema>;

export const CapabilityLifecycleSchema = z.object({
  state: CapabilityLifecycleStateSchema,
  reloadable: z.boolean(),
  requiresRestart: z.boolean(),
});
export type CapabilityLifecycle = z.infer<typeof CapabilityLifecycleSchema>;

export interface CapabilityDescriptor {
  /** Globally unique runtime id, e.g. `@org/ext#skill:format`. */
  capabilityId: string;
  kind: CapabilityKind;
  extensionId: string;
  extensionVersion: string;
  schemaVersion: number;
  origin: CapabilityOrigin;
  originPath: string;
  shadowedBy: ReadonlyArray<{ origin: CapabilityOrigin; originPath: string }>;
  trustTier: CapabilityTrustTier;
  permissions: readonly string[];
  dependencies: readonly string[];
  lifecycle: CapabilityLifecycle;
  isolation: CapabilityIsolation;
  generation: number;
  /** Host-visible identifier, such as a skill id or tool name. */
  localId: string;
  /** Optional projection metadata; adapters must treat it as opaque. */
  metadata?: Readonly<Record<string, unknown>>;
}

export interface CapabilitySnapshot {
  generation: number;
  loadedAt: number;
  capabilities: readonly CapabilityDescriptor[];
  issues: readonly string[];
}

export function emptyCapabilitySnapshot(): CapabilitySnapshot {
  return {
    generation: 0,
    loadedAt: 0,
    capabilities: [],
    issues: [],
  };
}
