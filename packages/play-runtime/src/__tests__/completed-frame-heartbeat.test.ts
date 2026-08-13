import { describe, expect, test } from 'bun:test';
import {
  createCompletedFrameHeartbeat,
  installCompletedFrameHeartbeat,
} from '../completed-frame-heartbeat';

describe('completed-frame heartbeat', () => {
  test('publishes only when completed-frame callbacks advance', () => {
    const completed = createCompletedFrameHeartbeat({ heartbeatMs: 100, sampleMs: 1000 });

    expect(completed(0)).toBeUndefined();
    expect(completed(99)).toBeUndefined();
    expect(completed(100)).toEqual({ fps: 0, sentinel: 1 });
    expect(completed(1000)).toEqual({ fps: 3, sentinel: 2 });
  });

  test('keeps heartbeat identity monotonic while sampling frame throughput', () => {
    const completed = createCompletedFrameHeartbeat({ heartbeatMs: 10, sampleMs: 20 });

    expect(completed(0)).toBeUndefined();
    expect(completed(10)).toEqual({ fps: 0, sentinel: 1 });
    expect(completed(20)).toEqual({ fps: 100, sentinel: 2 });
    expect(completed(30)).toEqual({ fps: 100, sentinel: 3 });
    expect(completed(40)).toEqual({ fps: 100, sentinel: 4 });
  });

  test('does no reporting until the renderer completion producer fires', () => {
    let listener: (() => void) | undefined;
    let now = 0;
    const published: unknown[] = [];
    const unsubscribe = installCompletedFrameHeartbeat({
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      now: () => now,
      publish: (heartbeat) => published.push(heartbeat),
      heartbeatMs: 10,
      sampleMs: 20,
    });

    now = 1000;
    expect(published).toEqual([]);
    listener?.();
    now = 1010;
    listener?.();
    expect(published).toEqual([{ fps: 0, sentinel: 1 }]);

    unsubscribe();
    expect(listener).toBeUndefined();
  });
});
