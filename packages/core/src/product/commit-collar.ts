import {
  CommitCollar,
  type AuthoredCommit,
  type CanonicalEffectContext,
  type CommitResult,
  type CommitRunRequest,
  type UndoRedoRequest,
} from '@forgeax/editor-product';

export interface GatewayCommitRequest {
  readonly runId: string;
  readonly operationId: string;
  readonly input: unknown;
  readonly actor?: CommitRunRequest['actor'];
  readonly sessionId?: string;
  readonly scope?: string;
  readonly idempotencyKey?: string;
  readonly expectedRevision?: string;
}

export interface GatewayCommitCollarOptions {
  readonly executeCanonical: (input: unknown, context: CanonicalEffectContext) => Promise<{
    readonly revision: string;
    readonly result: unknown;
    readonly inverse?: unknown;
  }>;
  readonly publishAuthored: (commit: AuthoredCommit) => void | Promise<void>;
  readonly now?: () => number;
}

export interface GatewayCommitCollar {
  readonly commit: (request: GatewayCommitRequest) => Promise<CommitResult>;
  readonly undo: (request: GatewayReplayRequest) => Promise<CommitResult>;
  readonly redo: (request: GatewayReplayRequest) => Promise<CommitResult>;
  readonly getRun: (runId: string) => ReturnType<CommitCollar['getRun']>;
  readonly getCommit: (runId: string) => ReturnType<CommitCollar['getCommit']>;
}

export interface GatewayReplayRequest extends GatewayCommitRequest {
  readonly sourceRunId: string;
}

function runFor(request: GatewayCommitRequest): CommitRunRequest {
  return {
    runId: request.runId,
    actor: request.actor ?? { id: 'editor', kind: 'system' },
    sessionId: request.sessionId ?? 'editor-session',
    scope: request.scope ?? 'editor-game',
    ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
  };
}

function replayFor(request: GatewayReplayRequest): UndoRedoRequest<unknown> {
  return {
    sourceRunId: request.sourceRunId,
    expectedRevision: request.expectedRevision ?? '',
    run: { ...runFor(request), operationId: request.operationId },
    input: request.input,
    effect: { commit: async (context) => ({ ...contextualEffect(context, request), result: context.input }) },
    authored: { publish: async () => {} },
  };
}

function contextualEffect(
  context: CanonicalEffectContext,
  request: GatewayReplayRequest,
): { readonly revision: string; readonly inverse?: unknown } {
  return { revision: context.expectedRevision ?? request.expectedRevision ?? 'revision-unknown' };
}

export function createGatewayCommitCollar(options: GatewayCommitCollarOptions): GatewayCommitCollar {
  const collar = new CommitCollar({ now: options.now });
  const commit = (request: GatewayCommitRequest): Promise<CommitResult> => collar.dispatch({
    operationId: request.operationId,
    input: request.input,
    run: runFor(request),
    expectedRevision: request.expectedRevision,
    effect: { commit: (context) => options.executeCanonical(context.input, context) },
    authored: { publish: options.publishAuthored },
  });
  const replay = (request: GatewayReplayRequest, kind: 'undo' | 'redo'): Promise<CommitResult> => {
    const replayRequest = replayFor(request);
    const effect = { commit: (context: CanonicalEffectContext) => options.executeCanonical(context.input, context) };
    return collar[kind]({ ...replayRequest, effect, authored: { publish: options.publishAuthored } });
  };
  return {
    commit,
    undo: (request) => replay(request, 'undo'),
    redo: (request) => replay(request, 'redo'),
    getRun: (runId) => collar.getRun(runId),
    getCommit: (runId) => collar.getCommit(runId),
  };
}

