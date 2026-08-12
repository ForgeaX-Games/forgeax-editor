import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createOperationRun, type OperationRunRequest } from '@forgeax/editor-product';
import { projectRunFacts } from '../run-view-model';

const operationSource = resolve(import.meta.dir, '../OperationCenter.tsx');
const operationText = readFileSync(operationSource, 'utf8');

const request: OperationRunRequest = {
  runId: 'run:headless:1',
  operationId: 'asset.reconcile',
  actor: { id: 'system', kind: 'system' },
  sessionId: 'session-1',
  scope: 'game:demo',
  traceId: 'trace-1',
  attempt: 1,
  cancellable: false,
  retryable: false,
};

describe('UI-free operation projection', () => {
  it('keeps terminal facts available without a mounted React adapter', () => {
    const result = createOperationRun(request, 1);
    if (!result.ok) throw new Error(result.error.hint);
    const facts = projectRunFacts({ run: result.value });

    expect(facts.runId).toBe('run:headless:1');
    expect(facts.status).toBe('accepted');
    expect(facts.isSuccess).toBe(false);
  });

  it('does not create a React effect, frame loop, or timer for stable facts', () => {
    expect(operationText).not.toContain('useEffect(');
    expect(operationText).not.toContain('requestAnimationFrame(');
    expect(operationText).not.toContain('setInterval(');
    expect(operationText).not.toContain('setTimeout(');
  });
});
