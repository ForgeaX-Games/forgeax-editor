import {
  createThinGatewayProjection,
  type ThinAuthoringRunRequest,
} from '@forgeax/editor-core';
import { createProjectAuthoringGatewayProjection } from '@forgeax/editor-core';
import type {
  AuthoringOperationDescriptor,
  AuthoringRunRequest,
  AuthoringRunResult,
} from './tool-client-contract';
import { createAuthoringToolClientTransport, type AuthoringToolClientTransport } from './tool-client-transport';

export interface AuthoringOperationsProjection {
  readonly authority: 'host-toolclient';
  readonly list: () => Promise<readonly AuthoringOperationDescriptor[]>;
  readonly describe: (operationId: string) => Promise<AuthoringOperationDescriptor>;
  readonly run: (request: AuthoringRunRequest) => Promise<AuthoringRunResult>;
}

export type AuthoringGatewayProjection = ReturnType<typeof createThinGatewayProjection>;

export function createAuthoringOperationsProjection(
  transport: AuthoringToolClientTransport = createAuthoringToolClientTransport(),
): AuthoringOperationsProjection {
  return {
    authority: 'host-toolclient',
    list: () => transport.list(),
    describe: (operationId) => transport.describe(operationId),
    run: (request) => transport.run(request),
  };
}

/** The Editor page is a projection; host ToolClient remains the executor. */
export function createAuthoringGatewayProjection(
  operations: Pick<AuthoringOperationsProjection, 'run'>,
): AuthoringGatewayProjection {
  return createThinGatewayProjection({
    run: (request: ThinAuthoringRunRequest) => operations.run({
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

export function createPageAuthoringGatewayProjection(
  transport?: AuthoringToolClientTransport,
): AuthoringGatewayProjection {
  return createProjectAuthoringGatewayProjection(transport ?? createAuthoringToolClientTransport());
}
