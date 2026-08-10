import { describe, expect, it } from 'bun:test';
import type { OpDescriptor } from '@forgeax/editor-core';
import { projectGatewayActions, projectViewportRuntimeOps } from '../gateway-action-projection';

const descriptor: OpDescriptor = {
  id: 'asset.rename',
  domain: 'document',
  source: 'builtin',
  title: 'Rename asset',
  argsSchema: {
    type: 'object',
    properties: { subjectId: { type: 'string' }, newName: { type: 'string' } },
    required: ['subjectId', 'newName'],
  },
};

describe('command palette product projection', () => {
  it('keeps capability payload and schema identical for UI and AI discovery', () => {
    const dispatched: Array<{ op: Record<string, unknown>; origin?: string }> = [];
    const source = {
      listOps: () => [descriptor],
      dispatch: (op: { kind: string; [key: string]: unknown }, origin?: string) => {
        dispatched.push({ op, origin });
        return { ok: true as const };
      },
    };

    const [action] = projectGatewayActions(source);
    expect(action).toMatchObject({
      id: descriptor.id,
      schema: descriptor.argsSchema,
      capability: 'write',
      surface: 'both',
    });

    const result = action?.run({ subjectId: 'asset-1', newName: 'Renamed' });
    expect(result).toEqual({ status: 'completed' });
    expect(dispatched).toEqual([{
      op: { kind: 'asset.rename', subjectId: 'asset-1', newName: 'Renamed' },
      origin: 'human',
    }]);
  });

  it('preserves structured rejection recovery without a UI-only branch', () => {
    const source = {
      listOps: () => [descriptor],
      dispatch: () => ({ ok: false as const, error: { code: 'revision-conflict', hint: 'Refresh before retrying.' } }),
    };
    const [action] = projectGatewayActions(source);
    expect(action?.run({})).toEqual({ status: 'rejected', reason: 'Refresh before retrying.' });
  });

  it('projects and disposes the Runtime manifest without a shell capability copy', async () => {
    const registered: Array<{ id: string; run: (args: Record<string, unknown>) => unknown }> = [];
    const disposed: string[] = [];
    const dispatched: Array<{ operationId: string; input: unknown }> = [];
    const dispose = await projectViewportRuntimeOps((action) => {
      registered.push(action);
      return () => disposed.push(action.id);
    }, {
      discover: async () => [
        {
          id: 'editor.setSelection',
          kind: 'operation',
          version: '1',
          subject: 'editor',
          verb: 'setSelection',
          inputSchema: { type: 'object' },
          outputSchema: null,
          availability: { available: true },
          preconditions: [],
          recoveryActions: [],
        },
        {
          id: 'editor.assetCatalogRefreshed',
          kind: 'query',
          version: '1',
          subject: 'editor',
          verb: 'assetCatalogRefreshed',
          inputSchema: null,
          outputSchema: null,
          availability: { available: true },
          preconditions: [],
          recoveryActions: [],
        },
      ],
      dispatch: async (operationId, input) => {
        dispatched.push({ operationId, input });
        return {
          jsonrpc: '2.0',
          version: 'editor-transport/v1',
          id: 'test',
          correlationId: 'test',
          result: { ok: true },
        };
      },
    });

    expect(registered.map(({ id }) => id)).toEqual(['setSelection']);
    await expect(registered[0]!.run({ entityId: 7 })).resolves.toEqual({ status: 'completed' });
    expect(dispatched).toEqual([{ operationId: 'setSelection', input: { entityId: 7 } }]);
    dispose();
    expect(disposed).toEqual(['setSelection']);
  });
});
