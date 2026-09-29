import { describe, expect, it } from 'bun:test';
import {
  shouldSupersedeStaleViewportBoot,
  waitForHostSurfaceGate,
  waitUntilDomConnected,
} from '../viewport-boot-gate';

describe('viewport-boot-gate', () => {
  it('shouldSupersedeStaleViewportBoot detects StrictMode remount', () => {
    const detached = { isConnected: false } as HTMLDivElement;
    const live = { isConnected: true } as HTMLDivElement;
    expect(shouldSupersedeStaleViewportBoot(false, null, live)).toBe(false);
    expect(shouldSupersedeStaleViewportBoot(true, live, live)).toBe(false);
    expect(shouldSupersedeStaleViewportBoot(true, detached, live)).toBe(true);
  });

  it('waitUntilDomConnected resolves when element connects mid-wait', async () => {
    let connected = false;
    const el = { get isConnected() { return connected; } } as HTMLElement;
    let frames = 0;
    const originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      frames += 1;
      if (frames === 2) connected = true;
      cb(0);
      return 0;
    };
    try {
      const ok = await waitUntilDomConnected(el, () => true, 10);
      expect(ok).toBe(true);
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
    }
  });

  it('waitForHostSurfaceGate is a no-op when host gate is disabled', async () => {
    const ok = await waitForHostSurfaceGate(() => true, 1);
    expect(ok).toBe(true);
  });
});
