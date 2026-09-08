import { describe, expect, it } from 'bun:test';
import { createAuthoringOperationsProjection } from '../tool-client-operations';
import { createAuthoringToolClientTransport } from '../tool-client-transport';

describe('UI authoring ToolClient transport', () => {
  it('forwards list, describe, and run to the host transport', async () => {
    const calls: string[] = [];
    const transport = createAuthoringToolClientTransport(async (path, init) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/tool-runtime/operations') return Response.json({ operations: [] });
      if (path.includes('/operations/')) return Response.json({ operation: { id: 'material.author.update' } });
      return Response.json({ ok: true, runId: 'run-1', operationId: 'material.author.update', beforeRevision: 'r1', afterRevision: 'r2', snapshot: {}, artifacts: [] });
    });
    const projection = createAuthoringOperationsProjection(transport);
    await projection.list();
    await projection.describe('material.author.update');
    await projection.run({ operationId: 'material.author.update', args: { subject: { kind: 'material', guid: 'm1' }, expectedRevision: 'r1', patch: {}, snapshot: { subject: { kind: 'material', guid: 'm1' }, revision: 'r1', state: {} } } });
    expect(calls).toEqual([
      'GET /api/tool-runtime/operations',
      'GET /api/tool-runtime/operations/material.author.update',
      'POST /api/tool-runtime/run',
    ]);
  });

  it('projects missing operation as structured unavailable without a local executor', async () => {
    const transport = createAuthoringToolClientTransport(async () => Response.json({ error: { code: 'authoring-operation-unavailable', hint: 'Install the Project Entry.' } }, { status: 404 }));
    await expect(transport.list()).rejects.toMatchObject({ code: 'authoring-operation-unavailable' });
  });

  it('preserves Engine failure fields when a provider returns an HTTP terminal error', async () => {
    const transport = createAuthoringToolClientTransport(async () => Response.json({
      error: {
        code: 'authoring-revision-conflict',
        expected: 'Project revision r7',
        hint: 'Refresh the Project and retry from the draft.',
        detail: { expectedRevision: 'r7', actualRevision: 'r8' },
        retryable: true,
        recoveryActions: ['authoring.refresh', 'authoring.retry'],
      },
    }, { status: 409 }));
    await expect(transport.run({ operationId: 'material.author.update', args: {} })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'authoring-revision-conflict',
        expected: 'Project revision r7',
        detail: { expectedRevision: 'r7', actualRevision: 'r8' },
        retryable: true,
        recoveryActions: ['authoring.refresh', 'authoring.retry'],
      },
    });
  });
});
