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

export interface AuthoringProjectSubject {
  readonly kind: 'material' | 'mesh' | 'vfx';
  readonly id: string;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface AuthoringProjectState {
  readonly revision: string;
  readonly subjects: Readonly<Record<string, AuthoringProjectSubject>>;
}

export interface AuthoringProjectWriteRequest {
  readonly expectedRevision: string;
  readonly subjects: Readonly<Record<string, AuthoringProjectSubject>>;
}

export interface AuthoringProjectWriteSuccess {
  readonly ok: true;
  readonly revision: string;
  readonly path: string;
}

export interface AuthoringProjectWriteFailure {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly hint: string;
    readonly recoveryActions: readonly string[];
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

export interface AuthoringTransactionRequest {
  readonly requestId: string;
  readonly subject: Pick<AuthoringProjectSubject, 'kind' | 'id'>;
  readonly snapshot: { readonly revision: string; readonly values: Readonly<Record<string, unknown>> };
  readonly expectedRevision: string;
  readonly patch: Readonly<Record<string, unknown>>;
}

export type AuthoringTransactionResult =
  | {
    readonly ok: true;
    readonly runId: string;
    readonly beforeRevision: string;
    readonly afterRevision: string;
    readonly snapshot: AuthoringProjectSubject & { readonly revision: string };
    readonly artifacts: readonly [{ readonly kind: 'project-file'; readonly path: string }];
  }
  | {
    readonly ok: false;
    readonly runId: string;
    readonly error: {
      readonly code: string;
      readonly hint: string;
      readonly expected?: string;
      readonly current?: string;
      readonly recoveryActions: readonly string[];
      readonly draft?: { readonly revision: string; readonly values: Readonly<Record<string, unknown>> };
      readonly details?: Readonly<Record<string, unknown>>;
    };
  };

export interface AuthoringTransactionPort {
  readonly read: () => Promise<AuthoringProjectState>;
  readonly write: (request: AuthoringProjectWriteRequest) => Promise<AuthoringProjectWriteSuccess | AuthoringProjectWriteFailure>;
}

/**
 * One producer transaction seam for material/mesh/VFX author updates. It
 * rereads the Project immediately before the CAS write, carries the draft in
 * every failure, and never publishes the merged values before write succeeds.
 */
export function createAuthoringTransaction(port: AuthoringTransactionPort) {
  return {
    async commit(request: AuthoringTransactionRequest): Promise<AuthoringTransactionResult> {
      const runId = request.requestId;
      const current = await port.read();
      const draft = { revision: request.snapshot.revision, values: { ...request.snapshot.values, ...request.patch } };
      const conflict = (code: string, hint: string, expected?: string, actual?: string, details?: Readonly<Record<string, unknown>>): AuthoringTransactionResult => ({
        ok: false,
        runId,
        error: {
          code,
          hint,
          ...(expected === undefined ? {} : { expected }),
          ...(actual === undefined ? {} : { current: actual }),
          recoveryActions: ['authoring.refresh', 'authoring.retry'],
          draft,
          ...(details === undefined ? {} : { details }),
        },
      });
      if (request.snapshot.revision !== request.expectedRevision) {
        return conflict('authoring-snapshot-revision-mismatch', 'expectedRevision does not identify the supplied Snapshot.', request.snapshot.revision, request.expectedRevision, { replayable: false, inverse: 'owner-defined' });
      }
      if (current.revision !== request.expectedRevision) {
        return conflict('authoring-revision-conflict', 'Project revision changed before the authority write.', request.expectedRevision, current.revision, { replayable: false, inverse: 'owner-defined' });
      }
      const subjectKey = `${request.subject.kind}:${request.subject.id}`;
      const existing = current.subjects[subjectKey];
      if (existing === undefined) return conflict('authoring-subject-missing', 'Project subject is unavailable for this authoring operation.');
      const nextSubject: AuthoringProjectSubject = { ...existing, values: { ...existing.values, ...request.patch } };
      const subjects = { ...current.subjects, [subjectKey]: nextSubject };
      const written = await port.write({ expectedRevision: request.expectedRevision, subjects });
      if (!written.ok) {
        return { ok: false, runId, error: { ...written.error, recoveryActions: written.error.recoveryActions.length > 0 ? written.error.recoveryActions : ['authoring.retry'], draft } };
      }
      return {
        ok: true,
        runId,
        beforeRevision: request.expectedRevision,
        afterRevision: written.revision,
        snapshot: { ...nextSubject, revision: written.revision },
        artifacts: [{ kind: 'project-file', path: written.path }],
      };
    },
  };
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
