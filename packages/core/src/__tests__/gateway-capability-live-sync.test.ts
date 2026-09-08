import { expect, test } from 'bun:test';

import type { GatewayOpDescriptor, GatewayOpSnapshot } from '../io/catalog';
import { createGatewayCapabilityAdapter } from '../product/gateway-executor';

test('product adapter follows live Gateway capability changes and releases its projection', () => {
  let revision = 1;
  let ops: readonly GatewayOpDescriptor[] = [{
    id: 'play',
    domain: 'session',
    argsSchema: null,
    source: 'builtin',
    title: 'Play',
    availability: {
      available: false,
      code: 'applier-unavailable',
      reason: 'Runtime is not connected.',
    },
  }];
  const listeners = new Set<(snapshot: GatewayOpSnapshot) => void>();
  const source = {
    listOps: () => ops,
    subscribeOps(listener: (snapshot: GatewayOpSnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch: () => ({ ok: true }),
  };
  const publish = (next: readonly GatewayOpDescriptor[]): void => {
    ops = next;
    const snapshot = { revision: ++revision, ops };
    for (const listener of [...listeners]) listener(snapshot);
  };
  const adapter = createGatewayCapabilityAdapter(source);

  expect(adapter.capabilities().find((entry) => entry.id === 'editor.play')?.availability).toMatchObject({
    available: false,
    code: 'executor-unavailable',
  });
  expect(adapter.acceptRun('play', {}, {
    actor: { id: 'agent-1', kind: 'ai' },
    sessionId: 'session-1',
    scope: 'game-1',
  })).toMatchObject({ ok: false, error: { code: 'executor-unavailable' } });

  publish([
    { ...ops[0]!, availability: { available: true } },
    {
      id: 'runtimePreviewProbe',
      domain: 'transient',
      argsSchema: { type: 'object' },
      source: 'registered',
      title: 'Runtime Preview Probe',
      availability: { available: true },
    },
  ]);
  expect(adapter.capabilities().map((entry) => entry.id).sort()).toEqual([
    'editor.play',
    'editor.runtimePreviewProbe',
  ]);
  expect(adapter.acceptRun('runtimePreviewProbe', {}, {
    actor: { id: 'agent-1', kind: 'ai' },
    sessionId: 'session-1',
    scope: 'game-1',
  })).toMatchObject({ ok: true });

  publish([ops[0]!]);
  expect(adapter.capabilities().map((entry) => entry.id)).toEqual(['editor.play']);

  adapter.dispose();
  expect(adapter.capabilities()).toEqual([]);
  publish([]);
  expect(adapter.capabilities()).toEqual([]);
});

test('registration projects operation confirmation, retry, cancellation, and recovery metadata', () => {
  const operationRun = {
    acceptedStatuses: ['accepted'] as const,
    terminalStatuses: ['succeeded', 'failed', 'cancelled'] as const,
    read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
    retry: { requiresNewRequestId: true },
    retention: { kind: 'terminal-only' as const, maxTerminalRuns: 8 },
    cancellable: false,
  };
  const adapter = createGatewayCapabilityAdapter({
    listOps: () => [{
      id: 'switchGameVersion', domain: 'session', source: 'builtin', argsSchema: null,
      title: 'Switch version', confirmation: { required: true, reason: 'Repository state changes.' },
      operationRun, recoveryActions: ['version-control.refresh', 'run.wait', 'run.retry'],
      availability: { available: true },
    }],
    dispatch: () => ({ ok: true }),
  });
  expect(adapter.capabilities()[0]).toMatchObject({
    id: 'editor.switchGameVersion',
    confirmation: { required: true, reason: 'Repository state changes.' },
    retry: { supported: true, createsNewAttempt: true },
    cancellation: { supported: false },
    recoveryActions: ['version-control.refresh', 'run.wait', 'run.retry'],
  });
  adapter.dispose();
});
