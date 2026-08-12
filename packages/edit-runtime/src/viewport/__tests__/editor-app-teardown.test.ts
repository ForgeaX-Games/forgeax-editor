import { describe, expect, it } from 'bun:test';
import {
  createEditorAppTeardown,
  createPagehideTeardown,
  teardownIfStale,
} from '../editor-app-teardown';

describe('editor app teardown', () => {
  it('removes the host error listener before stopping the app', () => {
    const events: string[] = [];

    const teardown = createEditorAppTeardown({
      unregisterErrorListener: () => events.push('unsubscribe-error'),
      disposeSession: () => events.push('dispose-session'),
      stopApp: () => events.push('stop-app'),
      removeCanvas: () => events.push('remove-canvas'),
    });

    teardown();

    expect(events).toEqual(['unsubscribe-error', 'dispose-session', 'stop-app', 'remove-canvas']);
  });

  it('tears down once for a real pagehide but preserves bfcache restores', () => {
    let calls = 0;
    const onPageHide = createPagehideTeardown(() => { calls += 1; });

    onPageHide({ persisted: true });
    expect(calls).toBe(0);

    onPageHide({ persisted: false });
    onPageHide({ persisted: false });
    expect(calls).toBe(1);
  });

  it('uses the full close sequence when an async boot becomes stale', () => {
    const events: string[] = [];
    const teardown = createEditorAppTeardown({
      unregisterErrorListener: () => events.push('unsubscribe-error'),
      disposeSession: () => events.push('dispose-session'),
      stopApp: () => events.push('stop-app'),
      removeCanvas: () => events.push('remove-canvas'),
    });

    expect(teardownIfStale(() => false, teardown)).toBe(true);
    expect(events).toEqual(['unsubscribe-error', 'dispose-session', 'stop-app', 'remove-canvas']);
    expect(teardownIfStale(() => true, teardown)).toBe(false);
  });
});
