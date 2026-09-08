import { describe, expect, test } from 'bun:test';
import {
  VERSION_CONTROL_OPERATION_IDS,
  versionControlOperationDescriptors,
} from '@forgeax/editor-core';
import { OperationRunRegistry } from '@forgeax/editor-core';

describe('version control Gateway operations', () => {
  test('publishes four session descriptors with confirmation and terminal run metadata', () => {
    expect(VERSION_CONTROL_OPERATION_IDS).toEqual([
      'configureGitExecutable',
      'initializeGameRepository',
      'publishGameVersion',
      'switchGameVersion',
    ]);
    const descriptors = versionControlOperationDescriptors();
    expect(descriptors).toHaveLength(4);
    for (const descriptor of descriptors) {
      expect(descriptor.domain).toBe('session');
      expect(descriptor.confirmation.required).toBe(true);
      expect(descriptor.operationRun?.terminalStatuses).toContain('succeeded');
      expect(descriptor.operationRun?.retry.requiresNewRequestId).toBe(true);
    }
  });

  test('replays the same request and requires a new requestId for retry', () => {
    const registry = new OperationRunRegistry();
    const command = { kind: 'publishGameVersion', requestId: 'request-1', tag: 'one' } as never;
    const first = registry.acceptOperation('request-1', command, { id: 'human', kind: 'human' }, {
      operationId: 'publishGameVersion', cancellable: false, retryable: true,
    });
    const replay = registry.acceptOperation('request-1', command, { id: 'human', kind: 'human' }, {
      operationId: 'publishGameVersion', cancellable: false, retryable: true,
    });
    expect(first.ok).toBe(true);
    expect(replay.ok && replay.reused).toBe(true);
    if (first.ok) registry.fail(first.run.runId, { code: 'version-control-command-failed', hint: 'retry', retryable: true } as never);
    const retry = registry.acceptOperation('request-2', { kind: 'publishGameVersion', requestId: 'request-2', tag: 'one' } as never, { id: 'human', kind: 'human' }, {
      operationId: 'publishGameVersion', cancellable: false, retryable: true,
    });
    expect(retry.ok).toBe(true);
    expect(retry.ok && retry.run.requestId).toBe('request-2');
  });
});
