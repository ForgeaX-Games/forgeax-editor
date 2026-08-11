import { describe, expect, it } from 'bun:test';
import {
  createDisposablePlayCarrier,
  type DisposablePlayFrame,
  type DisposablePlayFrameHost,
} from '../disposable-play-carrier';
import { createRunLifecycle } from '../run-lifecycle';

function harness() {
  const events: string[] = [];
  let listener: ((event: MessageEvent) => void) | null = null;
  const source = { postMessage: () => events.push('post-stop') } as unknown as WindowProxy;
  const frame = { generation: 1, source, element: {} as HTMLIFrameElement } satisfies DisposablePlayFrame;
  const host: DisposablePlayFrameHost = {
    create(generation, url) {
      events.push(`create:${generation}:${url}`);
      return { ...frame, generation };
    },
    mount() { events.push('mount'); },
    remove() { events.push('remove'); },
    subscribe(next) { listener = next; return () => { listener = null; events.push('unsubscribe'); }; },
  };
  const carrier = createDisposablePlayCarrier({
    container: {} as HTMLElement,
    url: (generation) => `/preview/?playGeneration=${generation}`,
    releaseEditSurface: async () => { events.push('release'); return { ok: true }; },
    restoreEditSurface: async () => { events.push('restore'); return { ok: true }; },
    host,
    readyTimeoutMs: 50,
  });
  return {
    carrier,
    events,
    ready() {
      listener?.({
        source,
        data: { type: 'VAG_CARRIER_HEARTBEAT', payload: { renderReadiness: 'ready' } },
      } as MessageEvent);
    },
  };
}

describe('disposable Play carrier', () => {
  it('releases Edit before mounting Play and hard-removes Play before restore', async () => {
    const h = harness();
    const started = h.carrier.start();
    await Promise.resolve();
    expect(h.events.slice(0, 3)).toEqual(['release', 'create:1:/preview/?playGeneration=1', 'mount']);
    h.ready();
    expect(await started).toEqual({ ok: true });
    expect(h.carrier.state()).toBe('play');

    expect(await h.carrier.stop()).toEqual({ ok: true });
    expect(h.events.indexOf('remove')).toBeLessThan(h.events.indexOf('restore'));
    expect(h.carrier.state()).toBe('edit');
  });

  it('destroys a child that never reaches first-frame readiness and restores Edit', async () => {
    const h = harness();
    const result = await h.carrier.start();
    expect(result).toMatchObject({ ok: false, error: { code: 'play-carrier-ready-timeout' } });
    expect(h.events).toContain('remove');
    expect(h.events.at(-1)).toBe('restore');
    expect(h.carrier.state()).toBe('edit');
  });

  it('keeps 50 remote Play/Stop cycles off the retained Edit World', async () => {
    const calls = { start: 0, stop: 0, enter: 0, exit: 0, assemble: 0, pause: 0, resume: 0 };
    const lifecycle = createRunLifecycle({
      editorApp: {
        pause: () => { calls.pause++; return { ok: true }; },
        resume: () => { calls.resume++; return { ok: true }; },
      },
      gateway: {
        enterPlay: () => { throw new Error('in-process Play must not be entered'); },
        enterRemotePlay: () => { calls.enter++; },
        exitPlay: () => { calls.exit++; },
        beginPlayAttempt: () => {},
      },
      remoteCarrier: {
        start: async () => { calls.start++; return { ok: true }; },
        stop: async () => { calls.stop++; return { ok: true }; },
      },
      assemble: async () => { calls.assemble++; return { ok: false, error: new Error('unreachable') }; },
    });

    for (let i = 0; i < 50; i++) {
      await lifecycle.playSimulation();
      await lifecycle.stopSimulation();
    }
    expect(calls).toEqual({ start: 50, stop: 50, enter: 50, exit: 50, assemble: 0, pause: 0, resume: 0 });
    expect(lifecycle.currentPlayWorld()).toBeNull();
  });
});
