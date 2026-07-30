import type {
  ResourceCommitResult,
  ResourcePrepareContext,
  ResourceTransactionPort,
} from '@forgeax/editor-product';

export interface ResourceSnapshotPort {
  readonly revision: string;
  readonly active: Readonly<Record<string, Uint8Array>>;
  readonly trash: readonly unknown[];
}

export interface ResourceChangePort {
  readonly kind: 'put' | 'move' | 'trash' | 'restore';
  readonly resourceId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly targetResourceId?: string;
  readonly bytes?: Uint8Array;
}

export interface ResourceMutationPort {
  readonly identity: string;
  readonly expectedRevision: string;
  readonly changes: readonly ResourceChangePort[];
}

export interface ResourceMutationResultPort {
  readonly identity: string;
  readonly beforeRevision: string;
  readonly afterRevision: string;
  readonly changed: boolean;
}

export type ResourceResultPort<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly hint: string; readonly [key: string]: unknown } };

export interface ResourceRootPort {
  readonly readSnapshot: () => Promise<ResourceSnapshotPort | ResourceResultPort<ResourceSnapshotPort>>;
  readonly commit: (mutation: ResourceMutationPort) => Promise<ResourceResultPort<ResourceMutationResultPort>>;
}

export interface PreparedResourceTransaction {
  readonly mutation: ResourceMutationPort;
  readonly commit: () => Promise<ResourceResultPort<ResourceMutationResultPort>>;
  readonly rollback?: () => Promise<void>;
}

export interface ResourceTransactionAdapter {
  readonly prepare: (
    request: Omit<ResourceMutationPort, 'expectedRevision'> & { readonly expectedRevision?: string },
  ) => Promise<ResourceResultPort<PreparedResourceTransaction>>;
  readonly asProductPort: <TInput>(
    build: (input: TInput, context: ResourcePrepareContext<TInput>) => Omit<ResourceMutationPort, 'expectedRevision'> & { readonly expectedRevision?: string },
  ) => ResourceTransactionPort<TInput>;
}

function isResult<T>(value: T | ResourceResultPort<T>): value is ResourceResultPort<T> {
  return typeof value === 'object' && value !== null && 'ok' in value;
}

function failed(code: string, hint: string): ResourceResultPort<never> {
  return { ok: false, error: { code, hint } };
}

export function createResourceTransactionAdapter(root: ResourceRootPort): ResourceTransactionAdapter {
  const prepare = async (
    request: Omit<ResourceMutationPort, 'expectedRevision'> & { readonly expectedRevision?: string },
  ): Promise<ResourceResultPort<PreparedResourceTransaction>> => {
    const snapshotResult = await root.readSnapshot();
    const snapshot = isResult(snapshotResult) ? snapshotResult : { ok: true as const, value: snapshotResult };
    if (!snapshot.ok) return failed(snapshot.error.code, snapshot.error.hint);
    const mutation: ResourceMutationPort = {
      identity: request.identity,
      expectedRevision: request.expectedRevision ?? snapshot.value.revision,
      changes: request.changes,
    };
    return {
      ok: true,
      value: {
        mutation,
        commit: () => root.commit(mutation),
      },
    };
  };

  const asProductPort = <TInput>(
    build: (input: TInput, context: ResourcePrepareContext<TInput>) => Omit<ResourceMutationPort, 'expectedRevision'> & { readonly expectedRevision?: string },
  ): ResourceTransactionPort<TInput> => ({
      prepare: async (input, context) => {
        const prepared = await prepare(build(input, context));
        if (!prepared.ok) throw new Error(prepared.error.hint);
        return {
          commit: async (): Promise<ResourceCommitResult> => {
            const result = await prepared.value.commit();
            if (!result.ok) throw new Error(result.error.hint);
            return { revision: result.value.afterRevision, result: result.value };
          },
        };
      },
    });
  return {
    prepare,
    asProductPort,
  };
}
