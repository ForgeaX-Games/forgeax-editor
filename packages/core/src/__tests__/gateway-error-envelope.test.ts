import { expect, test } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { createCommandError } from '@forgeax/editor-product';

import { EditGateway } from '../io/gateway';
import { OperationRunRegistry } from '../io/operation-runs';
import { createEditSession } from '../session/document';
import type { EditorOp } from '../types';

function gateway(): EditGateway {
  const session = createEditSession();
  session.world = new World();
  return new EditGateway(session);
}

test('Gateway dispatch adds operation context without parsing the hint', () => {
  const result = gateway().dispatch({ kind: 'missingOperation' } as EditorOp, 'ai');

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: 'UNKNOWN_OP',
      operationId: 'missingOperation',
      owner: 'editor-core',
      category: 'state',
      retryable: false,
      recoveryActions: [],
      objectRefs: { operation: { kind: 'operation', id: 'missingOperation' } },
    },
  });
  if (result.ok) return;
  expect(result.error.hint).toContain('listOps');
});

test('Gateway derives stable object refs from invalid operation args', () => {
  const result = gateway().dispatch({
    kind: 'setComponent',
    entity: 42,
    component: 'Transform',
    patch: null,
  } as unknown as EditorOp, 'ai');

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: 'INVALID_ARGS',
      operationId: 'setComponent',
      category: 'validation',
      objectRefs: {
        operation: { kind: 'operation', id: 'setComponent' },
        entity: { kind: 'entity', id: '42' },
        component: { kind: 'component', id: 'Transform' },
      },
    },
  });
});

test('OperationRun terminal failure preserves request and operation identity', async () => {
  const registry = new OperationRunRegistry({ scope: 'editor', now: () => 1 });
  const accepted = registry.acceptOperation('import-request-1', { destPath: 'assets/model.glb' }, { id: 'agent-1', kind: 'ai' }, {
    operationId: 'importAsset',
    cancellable: true,
    retryable: true,
  });
  expect(accepted).toMatchObject({ ok: true });
  if (!accepted.ok) return;
  expect(registry.markRunning(accepted.runId)).toMatchObject({ ok: true });

  const failed = registry.fail(accepted.runId, createCommandError({
    code: 'IMPORT_COOK_FAILED',
    hint: 'The importer rejected the source.',
    retryable: true,
    recoveryActions: ['operation.retry'],
  }));

  expect(failed).toMatchObject({
    ok: true,
    value: {
      status: 'failed',
      operationId: 'importAsset',
      requestId: 'import-request-1',
      error: {
        code: 'IMPORT_COOK_FAILED',
        operationId: 'importAsset',
        requestId: 'import-request-1',
        owner: 'editor-core',
        category: 'unknown',
        retryable: true,
        recoveryActions: ['operation.retry'],
      },
    },
  });
});

test('OperationRun exception failure exposes a structured cause', async () => {
  const registry = new OperationRunRegistry({ scope: 'editor', now: () => 1 });
  const accepted = registry.acceptOperation('save-request-1', {}, { id: 'agent-1', kind: 'ai' }, {
    operationId: 'saveDocToDisk',
    cancellable: false,
    retryable: true,
  });
  expect(accepted).toMatchObject({ ok: true });
  if (!accepted.ok) return;
  expect(registry.markRunning(accepted.runId)).toMatchObject({ ok: true });

  registry.bindCompletion(accepted.runId, Promise.reject(new Error('write failed')));
  const terminal = await registry.wait('save-request-1');
  expect(terminal).toMatchObject({
    ok: true,
    value: {
      status: 'failed',
      error: {
        code: 'operation-failed',
        operationId: 'saveDocToDisk',
        requestId: 'save-request-1',
        cause: { code: 'exception', owner: 'editor-core', hint: 'write failed' },
      },
    },
  });
});
