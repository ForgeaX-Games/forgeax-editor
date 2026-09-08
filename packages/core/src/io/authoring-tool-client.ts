import type {
  ToolDescriptor,
  ToolDomainFailure,
  ToolEvidenceKind,
  ToolTerminal,
} from '@forgeax/engine-tool-runtime';
import { createThinGatewayProjection, type ThinAuthoringRunRequest } from './gateway';

/** UI-facing projection of an Engine Tool Runtime descriptor. */
export type AuthoringOperationDescriptor = ToolDescriptor<unknown, unknown> & {
  readonly evidence?: readonly ToolEvidenceKind[];
};

/** The host transports opaque Project-owned arguments without normalizing them. */
export interface AuthoringRunRequest {
  readonly operationId: string;
  readonly args: unknown;
}

export type AuthoringRunResult =
  | ToolTerminal<unknown>
  | { readonly ok: false; readonly error: ToolDomainFailure; readonly runId?: string };

export interface AuthoringToolClientTransport {
  readonly list: () => Promise<readonly AuthoringOperationDescriptor[]>;
  readonly describe: (operationId: string) => Promise<AuthoringOperationDescriptor>;
  readonly run: (request: AuthoringRunRequest) => Promise<AuthoringRunResult>;
}

export interface AuthoringTransportError {
  readonly code: string;
  readonly expected?: string;
  readonly hint: string;
  readonly detail?: unknown;
  readonly retryable?: boolean;
  readonly recoveryActions?: readonly string[];
}

type AuthoringRunFailure = ToolDomainFailure & {
  readonly retryable?: boolean;
  readonly recoveryActions?: readonly string[];
};

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

async function readJson<T>(fetcher: Fetcher, path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(path, init);
  } catch (cause) {
    throw Object.assign(new Error('Authoring host transport is unavailable.'), {
      code: 'authoring-transport-unavailable',
      hint: 'The host-side ToolClient transport could not be reached.',
      cause,
    });
  }
  const value = await response.json().catch(() => undefined);
  if (!response.ok || value === undefined) {
    const error = value && typeof value === 'object' && 'error' in value ? value.error : undefined;
    const normalized = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    throw Object.assign(new Error(typeof normalized.hint === 'string' ? normalized.hint : `Authoring host returned HTTP ${response.status}.`), {
      code: typeof normalized.code === 'string' ? normalized.code : 'authoring-transport-failed',
      ...(typeof normalized.expected === 'string' ? { expected: normalized.expected } : {}),
      hint: typeof normalized.hint === 'string' ? normalized.hint : `Authoring host returned HTTP ${response.status}.`,
      ...(Object.hasOwn(normalized, 'detail') ? { detail: normalized.detail } : {}),
      ...(typeof normalized.retryable === 'boolean' ? { retryable: normalized.retryable } : {}),
      recoveryActions: Array.isArray(normalized.recoveryActions) ? normalized.recoveryActions : ['authoring.retry'],
    });
  }
  return value as T;
}

export function createAuthoringToolClientTransport(
  fetcher: Fetcher = fetch,
): AuthoringToolClientTransport {
  return {
    async list() {
      const body = await readJson<{ readonly operations: readonly AuthoringOperationDescriptor[] }>(fetcher, '/api/tool-runtime/operations');
      return body.operations;
    },
    async describe(operationId) {
      const body = await readJson<{ readonly operation: AuthoringOperationDescriptor }>(fetcher, `/api/tool-runtime/operations/${encodeURIComponent(operationId)}`);
      return body.operation;
    },
    run(request) {
      return readJson<AuthoringRunResult>(fetcher, '/api/tool-runtime/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      }).catch((cause) => {
        const error = cause as Partial<AuthoringTransportError>;
        const failure: AuthoringRunFailure = {
          code: typeof error.code === 'string' ? error.code : 'authoring-transport-failed',
          expected: typeof error.expected === 'string' ? error.expected : 'the host-side ToolClient transport to complete the authoring run',
          hint: typeof error.hint === 'string' ? error.hint : 'Reconnect the host ToolClient transport and retry from the serialized snapshot.',
          ...(Object.hasOwn(error, 'detail') ? { detail: error.detail as AuthoringRunFailure['detail'] } : {}),
          ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : { retryable: true }),
          recoveryActions: Array.isArray(error.recoveryActions) ? error.recoveryActions : ['authoring.retry'],
        };
        return { ok: false as const, error: failure };
      });
    },
  };
}

/** A UI projection only; descriptor, executor, and journal remain host-owned. */
export function createProjectAuthoringGatewayProjection(
  transport: Pick<AuthoringToolClientTransport, 'run'> = createAuthoringToolClientTransport(),
) {
  return createThinGatewayProjection({
    run: (request: ThinAuthoringRunRequest) => transport.run({
      operationId: request.operationId,
      args: {
        subject: request.subject,
        snapshot: request.snapshot,
        expectedRevision: request.expectedRevision,
        patch: request.patch,
      },
    }),
  });
}
