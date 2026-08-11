import { describe, expect, test } from 'bun:test';
import { createViewportRelocationController, type ActiveViewportCarrier, type PreparedViewportCarrier } from './viewport-relocation';

function carrier(
  id: string,
  kind: ActiveViewportCarrier['carrierKind'],
  events: string[],
  running: { count: number; max: number },
  options: { failReady?: boolean } = {},
): ActiveViewportCarrier {
  return {
    carrierId: id,
    carrierKind: kind,
    runtimeGeneration: 1,
    async start(generation) {
      events.push(`${id}:start:${generation}`);
      running.count += 1;
      running.max = Math.max(running.max, running.count);
      return { ok: true };
    },
    async waitFirstFrame() {
      events.push(`${id}:ready`);
      return options.failReady
        ? { ok: false, error: { code: 'first-frame-failed', hint: `${id} failed` } }
        : { ok: true };
    },
    async stop() { events.push(`${id}:stop`); running.count = Math.max(0, running.count - 1); },
    disposePrepared() { events.push(`${id}:dispose`); },
  };
}

describe('Viewport relocation lease', () => {
  test('saves and stops the old Runtime before starting the target', async () => {
    const events: string[] = [];
    const running = { count: 1, max: 1 };
    const initial = carrier('docked', 'iframe', events, running);
    const target = carrier('popup', 'browser-page', events, running);
    const controller = createViewportRelocationController({
      initial,
      prepare: async () => { events.push('popup:prepare'); return target as PreparedViewportCarrier; },
      save: async () => { events.push('save'); return { ok: true }; },
    });
    const result = await controller.relocate('browser-page');
    expect(result.ok).toBe(true);
    expect(events.slice(0, 5)).toEqual(['popup:prepare', 'save', 'docked:stop', 'popup:start:2', 'popup:ready']);
    expect(running.max).toBe(1);
    expect(controller.active().runtimeGeneration).toBe(2);
  });

  test('keeps the old lease on save failure and restarts it after target first-frame failure', async () => {
    const events: string[] = [];
    const running = { count: 1, max: 1 };
    const initial = carrier('docked', 'iframe', events, running);
    const blocked = carrier('popup', 'browser-page', events, running);
    let saveOk = false;
    const controller = createViewportRelocationController({
      initial,
      prepare: async () => blocked,
      save: async () => saveOk ? { ok: true } : { ok: false, error: { code: 'save-failed', hint: 'disk unavailable' } },
    });
    const saveFailure = await controller.relocate('browser-page');
    expect(saveFailure).toEqual({ ok: false, error: { code: 'save-failed', hint: 'disk unavailable', rolledBack: false } });
    expect(events).toEqual(['popup:dispose']);
    expect(running.count).toBe(1);

    saveOk = true;
    const failingTarget = carrier('popup-fail', 'browser-page', events, running, { failReady: true });
    const rollback = createViewportRelocationController({
      initial,
      prepare: async () => failingTarget,
      save: async () => ({ ok: true }),
    });
    const result = await rollback.relocate('browser-page');
    expect(result).toEqual({ ok: false, error: { code: 'first-frame-failed', hint: 'popup-fail failed', rolledBack: true } });
    expect(running.max).toBe(1);
    expect(rollback.active().carrierId).toBe('docked');
    expect(rollback.active().runtimeGeneration).toBe(3);
  });

  test('fails closed for prepare, concurrent relocation, and failed rollback', async () => {
    const events: string[] = [];
    const running = { count: 1, max: 1 };
    const initial = carrier('docked', 'iframe', events, running);
    const prepareFailure = createViewportRelocationController({
      initial,
      prepare: async () => { throw new Error('popup host unavailable'); },
      save: async () => ({ ok: true }),
    });
    expect(await prepareFailure.relocate('browser-page')).toEqual({
      ok: false,
      error: { code: 'viewport-target-unavailable', hint: 'popup host unavailable', rolledBack: false },
    });
    expect(prepareFailure.phase()).toBe('active');
    expect((await prepareFailure.relocate('iframe')).ok).toBe(true);

    let releasePrepare = () => {};
    const pendingPrepare = new Promise<PreparedViewportCarrier>((resolve) => { releasePrepare = () => resolve(carrier('popup', 'browser-page', events, running)); });
    const concurrent = createViewportRelocationController({
      initial,
      prepare: async () => pendingPrepare,
      save: async () => ({ ok: true }),
    });
    const pending = concurrent.relocate('browser-page');
    expect(await concurrent.relocate('tauri-webview')).toEqual({
      ok: false,
      error: { code: 'viewport-relocation-active', hint: 'Another Viewport relocation already owns the transition.', rolledBack: false },
    });
    releasePrepare();
    expect((await pending).ok).toBe(true);

    const brokenInitial: ActiveViewportCarrier = {
      ...carrier('broken-docked', 'iframe', events, running),
      async start() { return { ok: false, error: { code: 'restore-failed', hint: 'old carrier failed' } }; },
    };
    const failedTarget: PreparedViewportCarrier = {
      ...carrier('broken-popup', 'browser-page', events, running),
      async start() { return { ok: false, error: { code: 'start-failed', hint: 'new carrier failed' } }; },
    };
    const rollbackFailure = createViewportRelocationController({
      initial: brokenInitial,
      prepare: async () => failedTarget,
      save: async () => ({ ok: true }),
    });
    expect(await rollbackFailure.relocate('browser-page')).toEqual({
      ok: false,
      error: { code: 'viewport-relocation-rollback-failed', hint: 'old carrier failed', rolledBack: false },
    });
  });
});
