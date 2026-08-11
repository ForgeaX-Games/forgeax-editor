import { afterEach, describe, expect, it } from 'bun:test';
import { gateway, type PlayDirtyPolicy } from '@forgeax/editor-core';
import { registerViewportSessionAppliers } from '../viewport-session-appliers';

const registered: Array<() => void> = [];
afterEach(() => { for (const dispose of registered.splice(0)) dispose(); });

function deps() {
  const calls: string[] = [];
  const runtime = {
    replay: (entity: number) => {
      calls.push(`replay:${entity}`);
    },
  };
  const world = {
    addSystem: () => ({ unwrap: () => { calls.push('addSystem'); } }),
    removeSystem: () => ({ unwrap: () => { calls.push('removeSystem'); } }),
    get: (entity: number) => entity === 42
      ? { ok: true as const, value: {} }
      : { ok: false as const, error: new Error('missing player') },
    hasResource: () => true,
    getResource: () => runtime,
  } as never;
  return {
    calls,
    value: {
      play: (policy: PlayDirtyPolicy) => { calls.push(`play:${policy}`); return { ok: true as const }; },
      stop: () => { calls.push('stop'); },
      setDisplay: (display: 'scene' | 'game') => { calls.push(`display:${display}`); },
      grantGameControl: () => { calls.push('grant'); },
      releaseGameControl: () => { calls.push('release'); },
      captureFrame: async (frames: number) => { calls.push(`capture:${frames}`); return { runId: 'capture-test', tapePath: 'frame.tape.bin', reportPath: 'frame.report.json' }; },
      world,
      activeWorld: () => world,
      gateway,
    },
  };
}

describe('viewport session applier registrar (M3)', () => {
  it('registers viewport operations and routes calls to runtime deps', () => {
    const d = deps();
    registered.push(registerViewportSessionAppliers(d.value));
    expect(gateway.dispatch({ kind: 'play', dirtyPolicy: 'last-saved' })).toEqual({ ok: true });
    expect(gateway.dispatch({ kind: 'play', dirtyPolicy: 'prompt' } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    expect(gateway.dispatch({ kind: 'stop' })).toEqual({ ok: true });
    expect(gateway.dispatch({ kind: 'setDisplay', display: 'game' })).toEqual({ ok: true });
    expect(gateway.dispatch({ kind: 'grantGameControl' })).toEqual({ ok: true });
    expect(gateway.dispatch({ kind: 'releaseGameControl' })).toEqual({ ok: true });
    expect(gateway.dispatch({ kind: 'replayParticleEffect', entity: 42 })).toEqual({ ok: true });
    expect(gateway.dispatch({ kind: 'replayParticleEffect', entity: 43 })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGS' },
    });
    expect(gateway.dispatch({ kind: 'addSystem', name: '' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    expect(gateway.dispatch({ kind: 'removeSystem', name: 'test-system' })).toEqual({ ok: true });
    expect(gateway.dispatch({ kind: 'assignAssetToEntity', entity: -1, asset: { guid: 'x', kind: 'mesh', name: 'x' }, requestId: 'assign-invalid' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    expect(d.calls).toEqual(['play:last-saved', 'stop', 'display:game', 'grant', 'release', 'replay:42', 'removeSystem']);
  });

  it('captures through the gateway and exposes the recorder result via OperationRun', async () => {
    const d = deps();
    registered.push(registerViewportSessionAppliers(d.value));
    const requestId = 'capture-session-test';
    const accepted = gateway.dispatch({ kind: 'captureFrame', frames: 1, requestId }, 'ai');
    expect(accepted).toMatchObject({ ok: true, result: { operationRun: { requestId, operationId: 'captureFrame', status: 'running' } } });
    expect(await gateway.waitOperationRun(requestId)).toMatchObject({
      ok: true,
      value: {
        status: 'succeeded',
        progress: { fraction: 1, stage: 'succeeded' },
        result: { runId: 'capture-test', tapePath: 'frame.tape.bin', reportPath: 'frame.report.json' },
      },
    });
    expect(d.calls).toContain('capture:1');
  });

  it('reports missing RHI debug as a structured gateway error', () => {
    const d = deps();
    registered.push(registerViewportSessionAppliers({ ...d.value, captureFrame: undefined }));
    expect(gateway.dispatch({ kind: 'captureFrame', requestId: 'capture-no-debug' })).toMatchObject({
      ok: false,
      error: { code: 'rhi-debug-unavailable', retryable: true },
    });
  });

  it('retries a failed capture with a new request identity', async () => {
    const d = deps();
    let attempts = 0;
    registered.push(registerViewportSessionAppliers({
      ...d.value,
      captureFrame: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('debug upload failed');
        return { runId: 'capture-retry', tapePath: 'retry.tape.bin', reportPath: 'retry.report.json' };
      },
    }));
    expect(gateway.dispatch({ kind: 'captureFrame', requestId: 'capture-retry-source' }, 'ai')).toMatchObject({ ok: true });
    expect(await gateway.waitOperationRun('capture-retry-source')).toMatchObject({
      ok: true,
      value: { status: 'failed', retryable: true, error: { code: 'rhi-capture-failed' } },
    });
    expect(gateway.retryOperationRun('capture-retry-source', 'capture-retry-attempt-2', 'ai')).toMatchObject({
      ok: true,
      result: { operationRun: { requestId: 'capture-retry-attempt-2', parentRunId: expect.any(String), attempt: 2 } },
    });
    expect(await gateway.waitOperationRun('capture-retry-attempt-2')).toMatchObject({
      ok: true,
      value: { status: 'succeeded', result: { runId: 'capture-retry' } },
    });
  });

  it('preserves structured RHI timeout evidence in the Gateway cause', async () => {
    const d = deps();
    registered.push(registerViewportSessionAppliers({
      ...d.value,
      captureFrame: async () => {
        throw {
          code: 'snapshot-timeout',
          expected: 'frame-header resource snapshot completes within 30000 ms',
          hint: 'GPU readback did not complete',
          detail: {
            timeoutMs: 30000,
            stage: 'resource-readback',
            totalResources: 42,
            completedResources: 17,
            skippedResources: 3,
            currentHandleId: 'texture:99',
            currentKind: 'texture',
            elapsedMs: 30001,
          },
        };
      },
    }));
    expect(gateway.dispatch({ kind: 'captureFrame', requestId: 'capture-structured-error' }, 'ai')).toMatchObject({ ok: true });
    expect(await gateway.waitOperationRun('capture-structured-error')).toMatchObject({
      ok: true,
      value: {
        status: 'failed',
        error: {
          code: 'rhi-capture-failed',
          owner: 'engine',
          cause: {
            code: 'snapshot-timeout',
            owner: 'engine',
            details: {
              expected: 'frame-header resource snapshot completes within 30000 ms',
              detail: { completedResources: 17, currentKind: 'texture' },
            },
          },
        },
      },
    });
  });

  it('keeps capture resource failures as the terminal Gateway error code', async () => {
    const d = deps();
    registered.push(registerViewportSessionAppliers({
      ...d.value,
      captureFrame: async () => {
        throw {
          code: 'capture-disk-space-insufficient',
          hint: 'free disk space before retrying',
          detail: { availableBytes: 100, requiredBytes: 2048, frames: 2 },
        };
      },
    }));
    gateway.dispatch({ kind: 'captureFrame', frames: 2, requestId: 'capture-low-space' }, 'ai');
    expect(await gateway.waitOperationRun('capture-low-space')).toMatchObject({
      ok: true,
      value: {
        status: 'failed',
        error: {
          code: 'capture-disk-space-insufficient',
          retryable: true,
          cause: { code: 'capture-disk-space-insufficient' },
        },
      },
    });
  });

  it('fails a capture that never settles instead of leaving its OperationRun running forever', async () => {
    const d = deps();
    registered.push(registerViewportSessionAppliers({
      ...d.value,
      captureTimeoutMs: 10,
      captureFrame: () => new Promise<never>(() => undefined),
    }));
    expect(gateway.dispatch({ kind: 'captureFrame', requestId: 'capture-outer-timeout' }, 'ai')).toMatchObject({ ok: true });
    expect(await gateway.waitOperationRun('capture-outer-timeout')).toMatchObject({
      ok: true,
      value: {
        status: 'failed',
        progress: { fraction: 1, stage: 'failed' },
        error: {
          code: 'capture-timeout',
          cause: {
            code: 'capture-timeout',
            details: {
              expected: 'captureFrame completes within 10 ms',
              detail: { timeoutMs: 10, stage: 'capture' },
            },
          },
        },
      },
    });
  });

  it('validates display/name, rejects duplicate registration, and disposes idempotently', () => {
    const first = registerViewportSessionAppliers(deps().value);
    expect(() => registerViewportSessionAppliers(deps().value)).toThrow();
    expect(gateway.dispatch({ kind: 'setDisplay', display: 'bad' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    first();
    first();
    expect(gateway.dispatch({ kind: 'play' })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_OP' } });
  });
});
