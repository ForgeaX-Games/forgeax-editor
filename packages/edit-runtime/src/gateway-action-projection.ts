// gateway-action-projection — lossless UI action projection for editor ops.
// The gateway's listOps() is the only source of descriptors; this adapter never
// defines a second capability table and action execution only dispatches the
// corresponding gateway operation.

import type { OpDescriptor } from '@forgeax/editor-core';

export interface GatewayActionSource {
  listOps(): readonly OpDescriptor[];
  dispatch(op: { kind: string; [key: string]: unknown }, origin?: string): { ok: true } | { ok: false; error: { code: string; hint?: string } };
}

export interface ProjectedGatewayAction {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly schema?: Record<string, unknown>;
  readonly capability: 'delete' | 'write' | 'other';
  readonly surface: 'ui';
  readonly run: (args: Record<string, unknown>) => { status: 'completed' | 'rejected'; reason?: string };
}

export type RegisterGatewayAction = (action: ProjectedGatewayAction) => () => void;

function capabilityFor(descriptor: OpDescriptor): ProjectedGatewayAction['capability'] {
  if (descriptor.id.toLowerCase().includes('delete')) return 'delete';
  if (descriptor.domain === 'document' || descriptor.domain === 'session') return 'write';
  return 'other';
}

export function projectGatewayOps(source: GatewayActionSource, register: RegisterGatewayAction): () => void {
  const disposers = source.listOps().map((descriptor) => register({
    id: descriptor.id,
    title: descriptor.title ?? descriptor.id,
    description: `Dispatch editor operation ${descriptor.id}.`,
    ...(descriptor.argsSchema ? { schema: descriptor.argsSchema as unknown as Record<string, unknown> } : {}),
    capability: capabilityFor(descriptor),
    surface: 'ui',
    run: (args) => {
      const result = source.dispatch({ kind: descriptor.id, ...args }, 'human');
      return result.ok ? { status: 'completed' } : { status: 'rejected', reason: result.error.hint ?? result.error.code };
    },
  }));
  return () => {
    for (let i = disposers.length - 1; i >= 0; i--) disposers[i]!();
  };
}
