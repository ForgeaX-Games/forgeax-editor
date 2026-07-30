import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createOperationRun, type OperationRunRequest } from '@forgeax/editor-product';
import { projectRunFacts } from '@forgeax/editor-panels';

const runtimeSource = readFileSync(resolve(import.meta.dir, '../main.tsx'), 'utf8');

const request: OperationRunRequest = {
  runId: 'run:clock:1',
  operationId: 'document.query',
  actor: { id: 'ai-1', kind: 'ai' },
  sessionId: 'session-1',
  scope: 'game:demo',
  traceId: 'trace:clock:1',
  attempt: 1,
  cancellable: false,
  retryable: false,
};

describe('projection clock isolation', () => {
  it('keeps a stable headless fact after the UI entry is removed', () => {
    const result = createOperationRun(request, 1);
    if (!result.ok) throw new Error(result.error.hint);
    const before = projectRunFacts({ run: result.value });
    const after = projectRunFacts({ run: result.value });
    expect(after).toEqual(before);
  });

  it('does not add a second runtime business clock to the entry module', () => {
    expect(runtimeSource).not.toContain('setInterval(');
    expect(runtimeSource).not.toContain('setTimeout(');
    expect(runtimeSource).not.toContain('requestAnimationFrame(');
  });
});
