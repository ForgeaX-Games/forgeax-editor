// gateway-action-projection — lossless UI action projection for editor ops.
// The gateway's listOps() is the only source of descriptors; this adapter never
// defines a second capability table and action execution only dispatches the
// corresponding gateway operation.

import {
  discoverViewportRuntimeCapabilities,
  dispatchViewportRuntimeOperation,
  type OpDescriptor,
} from '@forgeax/editor-core';

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
  readonly surface: 'both';
  readonly run: (args: Record<string, unknown>) =>
    | { status: 'completed' | 'rejected'; reason?: string }
    | Promise<{ status: 'completed' | 'rejected'; reason?: string }>;
}

export type RegisterGatewayAction = (action: ProjectedGatewayAction) => () => void;

export interface ViewportGatewayActionSource {
  discover(): ReturnType<typeof discoverViewportRuntimeCapabilities>;
  dispatch(operationId: string, input: unknown): ReturnType<typeof dispatchViewportRuntimeOperation>;
}

const viewportGatewayActionSource: ViewportGatewayActionSource = {
  discover: discoverViewportRuntimeCapabilities,
  dispatch: dispatchViewportRuntimeOperation,
};

function capabilityFor(descriptor: OpDescriptor): ProjectedGatewayAction['capability'] {
  if (descriptor.id.toLowerCase().includes('delete')) return 'delete';
  if (descriptor.domain === 'document' || descriptor.domain === 'session') return 'write';
  return 'other';
}

export function projectGatewayActions(source: GatewayActionSource): readonly ProjectedGatewayAction[] {
  return Object.freeze(source.listOps().map((descriptor): ProjectedGatewayAction => ({
    id: descriptor.id,
    title: descriptor.title ?? descriptor.id,
    description: `Dispatch editor operation ${descriptor.id}.`,
    ...(descriptor.argsSchema ? { schema: descriptor.argsSchema as unknown as Record<string, unknown> } : {}),
    capability: capabilityFor(descriptor),
    surface: 'both',
    run: (args: Record<string, unknown>) => {
      const result = source.dispatch({ kind: descriptor.id, ...args }, 'human');
      return result.ok ? { status: 'completed' } : { status: 'rejected', reason: result.error.hint ?? result.error.code };
    },
  })));
}

export function projectGatewayOps(source: GatewayActionSource, register: RegisterGatewayAction): () => void {
  const disposers = projectGatewayActions(source).map((action) => register(action));
  return () => {
    for (let i = disposers.length - 1; i >= 0; i--) disposers[i]!();
  };
}

/** Project Runtime-owned Gateway capabilities into the disposable shell registry. */
export async function projectViewportRuntimeOps(
  register: RegisterGatewayAction,
  source: ViewportGatewayActionSource = viewportGatewayActionSource,
): Promise<() => void> {
  const capabilities = await source.discover();
  const disposers = capabilities
    .filter((descriptor) => (
      descriptor.subject === 'editor'
      && descriptor.kind === 'operation'
      && descriptor.availability.available
    ))
    .map((descriptor) => register({
      id: descriptor.verb,
      title: descriptor.verb,
      description: `Dispatch editor operation ${descriptor.verb}.`,
      ...(descriptor.inputSchema ? { schema: descriptor.inputSchema as Record<string, unknown> } : {}),
      capability: descriptor.verb.toLowerCase().includes('delete') ? 'delete' : 'write',
      surface: 'both',
      run: async (args) => {
        const response = await source.dispatch(descriptor.verb, args);
        return response.error === undefined
          ? { status: 'completed' as const }
          : { status: 'rejected' as const, reason: response.error.hint ?? response.error.code };
      },
    }));
  return () => {
    for (let i = disposers.length - 1; i >= 0; i -= 1) disposers[i]!();
  };
}
