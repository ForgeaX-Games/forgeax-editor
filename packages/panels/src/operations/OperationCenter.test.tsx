import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createOperationRun, type OperationRunRequest } from '@forgeax/editor-product';
import { buildOperationCenterRows, projectRunFacts } from './run-view-model';

const source = readFileSync(resolve(import.meta.dir, 'OperationCenter.tsx'), 'utf8');

function run() {
  const request: OperationRunRequest = {
    runId: 'run:save:1',
    operationId: 'document.save',
    actor: { id: 'ai-1', kind: 'ai' },
    sessionId: 'session-1',
    scope: 'game:demo',
    traceId: 'trace:save:1',
    attempt: 1,
    cancellable: false,
    retryable: true,
  };
  const result = createOperationRun(request, 1);
  if (!result.ok) throw new Error(result.error.hint);
  return result.value;
}

describe('Operation Center component contract', () => {
  it('renders the product facts needed for an actionable terminal surface', () => {
    expect(source).toContain('data-testid="operation-center"');
    expect(source).toContain('runId');
    expect(source).toContain('actor');
    expect(source).toContain('parentRunId');
    expect(source).toContain('progress');
    expect(source).toContain('recoveryActions');
    expect(source).toContain('onAction');
  });

  it('does not map accepted to success in the component-facing rows', () => {
    const row = buildOperationCenterRows([projectRunFacts({ run: run() })])[0];
    expect(row?.status).toBe('accepted');
    expect(row?.isSuccess).toBe(false);
  });
});
