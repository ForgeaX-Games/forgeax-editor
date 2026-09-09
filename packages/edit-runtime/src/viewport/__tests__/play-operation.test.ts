import { expect, test } from 'bun:test';
import { EditGateway, createEditSession } from '@forgeax/editor-core';
import { registerApplier } from '../../../../core/src/io/appliers';
import { createPlayOperation } from '../play-operation';
import { registerViewportSessionAppliers } from '../viewport-session-appliers';
import { createRunLifecycle } from '../run-lifecycle';
import type { PlayAssembly } from '../play-assemble';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function rig(dirty = false) {
  const assembly = deferred<{ ok: true; value: PlayAssembly } | { ok: false; error: unknown }>();
  const gateway = new EditGateway(createEditSession());
  let attempts = 0;
  const lifecycle = createRunLifecycle({
    gateway,
    editorApp: { pause: () => ({ ok: true }), resume: () => ({ ok: true }) },
    assemble: () => { attempts++; return assembly.promise; },
  });
  const operation = createPlayOperation({
    gateway, lifecycle: () => lifecycle, hasPendingDiskSave: () => dirty,
    invalidateScene() {}, onFailure() {},
  });
  return { operation, gateway, assembly, attempts: () => attempts };
}

test('real lifecycle caught assembly failure reaches the Play completion', async () => {
  const r = rig();
  const started = r.operation.play();
  expect(started.ok).toBe(true);
  r.assembly.resolve({ ok: false, error: { code: 'bad-bootstrap', hint: 'entry failed' } });
  expect(await started.completion).toMatchObject({ ok: false, error: { code: 'bad-bootstrap', hint: 'entry failed' } });
  expect(r.gateway.playPhase).toBe('failed');
});

test('a thrown assembly error is not mistaken for resolved success', async () => {
  const r = rig();
  const started = r.operation.play();
  r.assembly.reject(new Error('bootstrap threw'));
  expect(await started.completion).toMatchObject({ ok: false, error: { code: 'play-assemble-failed', hint: 'bootstrap threw' } });
});

test('duplicate Play shares startup; Stop settles it without waiting for assembly', async () => {
  const r = rig();
  const first = r.operation.play();
  const second = r.operation.play();
  expect(second.completion).toBe(first.completion);
  await Promise.resolve();
  expect(r.attempts()).toBe(1);
  r.operation.stop();
  expect(await first.completion).toMatchObject({ ok: false, error: { code: 'play-cancelled' } });
  r.assembly.resolve({ ok: false, error: 'late failure' });
  await Promise.resolve();
  expect(r.gateway.playPhase).toBe('edit');
});

test('already active Play succeeds without restarting the world', () => {
  const r = rig();
  r.gateway.enterRemotePlay();
  expect(r.operation.play()).toEqual({ ok: true });
  expect(r.attempts()).toBe(0);
});

test('save-then-play reports asynchronous save failure and never starts assembly', async () => {
  const save = deferred<unknown>();
  const restore = registerApplier('session', 'saveDocToDisk', () => ({ ok: true, completion: save.promise }));
  try {
    const r = rig(true);
    const started = r.operation.play('save-then-play');
    await Promise.resolve();
    save.resolve({ ok: false, error: { code: 'disk-full', hint: 'No space left', retryable: true, recoveryActions: [] } });
    expect(await started.completion).toMatchObject({ ok: false, error: { code: 'play-save-failed', hint: 'No space left' } });
    expect(r.attempts()).toBe(0);
  } finally { restore(); }
});

test('Stop while save is pending cannot start Play after the save completes', async () => {
  const save = deferred<unknown>();
  const restore = registerApplier('session', 'saveDocToDisk', () => ({ ok: true, completion: save.promise }));
  try {
    const r = rig(true);
    const started = r.operation.play('save-then-play');
    await Promise.resolve();
    r.operation.stop();
    expect(await started.completion).toMatchObject({ ok: false, error: { code: 'play-cancelled' } });
    save.resolve({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.attempts()).toBe(0);
  } finally { restore(); }
});


test('Stop then immediate Play isolates the old cancellation handler and terminal callback', async () => {
  const r = rig();
  const restore = registerViewportSessionAppliers({
    play: r.operation.play, stop: r.operation.stop, gateway: r.gateway,
    setDisplay() {}, grantGameControl() {}, releaseGameControl() {},
    replayParticleEffect: () => ({ ok: true }), world: {} as never, activeWorld: () => ({} as never),
  });
  try {
    r.gateway.dispatch({ kind: 'play', requestId: 'old-play' });
    await Promise.resolve();
    r.gateway.dispatch({ kind: 'stop' });
    r.gateway.dispatch({ kind: 'play', requestId: 'new-play' });
    expect(await r.gateway.waitOperationRun('old-play')).toMatchObject({ ok: true, value: { status: 'cancelled' } });
    expect(r.gateway.getOperationRunResult('new-play')).toMatchObject({ ok: true, value: { status: 'running' } });
    r.gateway.cancelOperationRun('new-play');
    expect(await r.gateway.waitOperationRun('new-play')).toMatchObject({ ok: true, value: { status: 'cancelled' } });
    r.assembly.resolve({ ok: false, error: 'late' });
  } finally { r.operation.stop(); restore(); }
});

test('dirty cancel policy during an existing startup observes the same pending attempt', async () => {
  const r = rig(true);
  const first = r.operation.play('last-saved');
  expect(r.operation.play('cancel').completion).toBe(first.completion);
  r.operation.stop();
  expect(await first.completion).toMatchObject({ ok: false, error: { code: 'play-cancelled' } });
});

test('a delayed successful remote startup becomes successful only after activation', async () => {
  const ready = deferred<{ ok: true }>();
  const gateway = new EditGateway(createEditSession());
  let starts = 0;
  const lifecycle = createRunLifecycle({
    gateway, editorApp: { pause: () => ({ ok: true }), resume: () => ({ ok: true }) },
    assemble: async () => { throw new Error('remote carrier owns assembly'); },
    remoteCarrier: {
      start: () => { starts++; return ready.promise; }, stop: async () => ({ ok: true }), pause() {}, resume() {},
      state: () => 'entering-play', gameplayDescriptors: () => ({ actions: [], reads: [] }) as never,
      gameplay: async () => ({ ok: false }) as never,
    },
  });
  const operation = createPlayOperation({ gateway, lifecycle: () => lifecycle, hasPendingDiskSave: () => false, invalidateScene() {}, onFailure() {} });
  const started = operation.play();
  let settled = false;
  void started.completion?.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(gateway.playPhase).toBe('starting');
  ready.resolve({ ok: true });
  expect(await started.completion).toEqual({ ok: true });
  expect(gateway.playPhase).toBe('play');
  expect(operation.play()).toEqual({ ok: true });
  expect(starts).toBe(1);
  operation.stop();
});


test('save-then-play waits for save and then for the actual assembly outcome', async () => {
  const save = deferred<unknown>();
  const restore = registerApplier('session', 'saveDocToDisk', () => ({ ok: true, completion: save.promise }));
  try {
    const r = rig(true);
    const started = r.operation.play('save-then-play');
    await Promise.resolve();
    expect(r.attempts()).toBe(0);
    save.resolve({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.attempts()).toBe(1);
    expect(r.gateway.playPhase).toBe('starting');
    r.assembly.resolve({ ok: false, error: { code: 'play-assemble-failed', hint: 'saved entry failed' } });
    expect(await started.completion).toMatchObject({ ok: false, error: { hint: 'saved entry failed', retryable: false } });
  } finally { restore(); }
});
