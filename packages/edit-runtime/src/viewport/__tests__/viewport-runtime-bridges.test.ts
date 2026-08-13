import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { installFpsReport, installVisibilityPause } from '../viewport-runtime-bridges';

let previousIntersectionObserver: typeof IntersectionObserver | undefined;
let previousDocument: Document | undefined;

beforeAll(() => {
  previousIntersectionObserver = globalThis.IntersectionObserver;
  previousDocument = globalThis.document;
});

afterAll(() => {
  if (previousIntersectionObserver === undefined) {
    delete (globalThis as { IntersectionObserver?: typeof IntersectionObserver })
      .IntersectionObserver;
  } else {
    globalThis.IntersectionObserver = previousIntersectionObserver;
  }
  if (previousDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = previousDocument;
  }
});

describe('installVisibilityPause', () => {
  it('reapplies the current visibility state when the active app changes', () => {
    let notifyIntersection: ((entries: IntersectionObserverEntry[]) => void) | undefined;
    class FakeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        notifyIntersection = (entries) => callback(entries, this as unknown as IntersectionObserver);
      }
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
      readonly root = null;
      readonly rootMargin = '0px';
      readonly thresholds = [0];
      readonly scrollMargin = '0px';
    }
    globalThis.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;

    const listeners = new Map<string, EventListenerOrEventListenerObject>();
    globalThis.document = {
      visibilityState: 'visible',
      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        listeners.set(type, listener);
      },
      removeEventListener(type: string): void {
        listeners.delete(type);
      },
    } as unknown as Document;

    const editor = { pause: mock(() => {}), resume: mock(() => {}) };
    const play = { pause: mock(() => {}), resume: mock(() => {}) };
    let activePlay: typeof play | null = null;
    const container = {} as HTMLElement;
    const visibility = installVisibilityPause(container, editor, () => activePlay);

    notifyIntersection?.([{ isIntersecting: false } as IntersectionObserverEntry]);
    expect(editor.pause).toHaveBeenCalledTimes(1);

    activePlay = play;
    visibility.refresh();
    expect(play.pause).toHaveBeenCalledTimes(1);

    notifyIntersection?.([{ isIntersecting: true } as IntersectionObserverEntry]);
    expect(play.resume).toHaveBeenCalledTimes(1);

    activePlay = null;
    visibility.refresh();
    expect(editor.resume).toHaveBeenCalledTimes(1);

    visibility();
  });
});

describe('installFpsReport', () => {
  it('publishes only renderer-completed frames and unsubscribes cleanly', () => {
    let listener: (() => void) | undefined;
    const unsubscribe = mock(() => {});
    const samples: number[] = [];
    const previousPerformance = globalThis.performance;
    let now = 0;
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: { now: () => now },
    });
    try {
      const dispose = installFpsReport(
        (next) => {
          listener = next;
          return unsubscribe;
        },
        { onFps: (fps) => samples.push(fps) },
      );

      now = 999;
      expect(samples).toEqual([]);
      for (let index = 1; index < 120; index++) {
        now = (index * 1_000) / 120;
        listener?.();
      }
      expect(samples).toEqual([]);

      now = 1_000;
      listener?.();
      expect(samples).toEqual([120]);

      dispose();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(globalThis, 'performance', {
        configurable: true,
        value: previousPerformance,
      });
    }
  });
});
