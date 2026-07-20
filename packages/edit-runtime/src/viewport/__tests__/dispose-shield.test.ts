// dispose-shield.test.ts (w6/w8) — unit test the renderer dispose-shield Proxy.
//
// feat-20260707-editor-world-fork-ssot-level-load-play-activeworld M2.
//
// WHY the shield exists (plan-strategy D-2 / R-N2): the engine `app.stop()`
// cleanup funnel calls `renderer.dispose()` UNCONDITIONALLY — even the assemble
// form (which claims the host owns backend lifecycle) chains stop -> cleanupFunnel
// -> rendererDispose (create-app.ts:846-950). play uses a SINGLE host-owned
// renderer shared across editWorld and playWorld (D-1); if playApp.stop() disposed
// it, the shared renderer's GPU device would die and the editWorld viewport would
// go black. The shield is a JS Proxy that wraps the real renderer and intercepts
// ONLY `dispose` as a silent no-op; every other member passes through by
// reference (draw/onError/assets/... unchanged), so playApp gets a clean stop
// (rAF cancel + renderer.onError unsubscribe) WITHOUT killing the shared renderer.
//
// engine-side fix pending (R-N2): once the engine assemble form exempts the
// host-owned renderer from the stop-time dispose (symmetric with the audio
// exemption it already has), this shield retires — see the removal anchor in
// play-assemble.ts.
//
// Anchors:
//   plan-strategy D-2 (dispose-shield — dispose no-op, other members pass-through)
//   plan-strategy R-N2 (app.stop() unconditional renderer.dispose() is an assemble
//     contract defect; shield is the editor-side minimal compensation)
//   requirements AC-05 (repeated ▶/■ GC — stop must clean up without killing renderer)

import { describe, expect, it } from 'bun:test';
import { shieldRendererDispose } from '../play-assemble';

// A minimal fake renderer that records dispose calls and exposes a couple of
// non-dispose members so we can assert transparent pass-through.
function makeFakeRenderer() {
  let disposeCalls = 0;
  const drawCalls: unknown[] = [];
  const assets = { marker: 'the-real-assets' };
  const renderer = {
    assets,
    draw(world: unknown) {
      drawCalls.push(world);
      return { ok: true } as const;
    },
    dispose() {
      disposeCalls += 1;
    },
    onError(_cb: (e: unknown) => void) {
      return () => {};
    },
  };
  return {
    renderer,
    get disposeCalls() {
      return disposeCalls;
    },
    drawCalls,
    assets,
  };
}

describe('w8 — renderer dispose-shield Proxy', () => {
  it('(a) non-dispose members pass through transparently', () => {
    const fr = makeFakeRenderer();
    const shielded = shieldRendererDispose(fr.renderer as never) as unknown as typeof fr.renderer;

    // assets is the SAME reference (pass-through, not a copy).
    expect(shielded.assets).toBe(fr.assets);

    // draw() forwards to the real renderer and returns its value.
    const world = { id: 'play-world' };
    const r = shielded.draw(world);
    expect(r).toEqual({ ok: true });
    expect(fr.drawCalls).toEqual([world]);

    // onError() forwards and returns the real unsubscribe callable.
    const unsub = shielded.onError(() => {});
    expect(typeof unsub).toBe('function');
  });

  it('(b) calling dispose() on the shielded renderer is a silent no-op', () => {
    const fr = makeFakeRenderer();
    const shielded = shieldRendererDispose(fr.renderer as never) as unknown as typeof fr.renderer;
    // Must not throw and must not call through.
    expect(() => shielded.dispose()).not.toThrow();
  });

  it('(c) the underlying real renderer dispose is never called through the shield', () => {
    const fr = makeFakeRenderer();
    const shielded = shieldRendererDispose(fr.renderer as never) as unknown as typeof fr.renderer;
    shielded.dispose();
    shielded.dispose();
    shielded.dispose();
    expect(fr.disposeCalls).toBe(0);
    // The real renderer's own dispose still works when called directly (the
    // shield only guards the proxied path, not the original object).
    fr.renderer.dispose();
    expect(fr.disposeCalls).toBe(1);
  });

  it('(d) the shield preserves object identity semantics for repeated access', () => {
    const fr = makeFakeRenderer();
    const shielded = shieldRendererDispose(fr.renderer as never) as unknown as typeof fr.renderer;
    // Same member accessed twice yields the same underlying value (draw is a
    // bound-through method; assets is a stable reference).
    expect(shielded.assets).toBe(shielded.assets);
    expect(shielded.assets).toBe(fr.assets);
  });
});
