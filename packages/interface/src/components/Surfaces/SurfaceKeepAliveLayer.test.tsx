import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const observed: Element[] = [];

class TestResizeObserver {
  observe(el: Element): void {
    observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {}
}

describe('SurfaceKeepAliveLayer anchor resize tracking', () => {
  let host: HTMLDivElement;
  let root: Root;
  let resetAnchors: () => void = () => {};
  let registeredDom = false;

  beforeEach(() => {
    try {
      GlobalRegistrator.register();
      registeredDom = true;
    } catch {
      registeredDom = false;
    }
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    observed.length = 0;
    resetAnchors = () => {};
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    resetAnchors();
    if (registeredDom) GlobalRegistrator.unregister();
  });

  it('observes an edit anchor that registers after the keep-alive layer mounts', async () => {
    const { SurfaceKeepAliveLayer } = await import('./SurfaceKeepAliveLayer');
    const { setAnchor, _resetSurfaceAnchorsForTests } = await import('../../lib/surfaceAnchors');
    const { useShellStore } = await import('../../store');

    resetAnchors = _resetSurfaceAnchorsForTests;
    resetAnchors();
    useShellStore.setState({ mode: 'scene' });

    act(() => {
      root.render(<SurfaceKeepAliveLayer />);
    });

    const anchor = document.createElement('div');
    act(() => {
      setAnchor('edit', anchor);
    });

    expect(observed).toContain(anchor);
  });
});
