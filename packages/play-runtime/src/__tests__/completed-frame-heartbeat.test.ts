import { describe, expect, test } from 'bun:test';
import {
  createCompletedFrameHeartbeat,
  installCompletedFrameHeartbeat,
} from '../completed-frame-heartbeat';

describe('completed-frame heartbeat', () => {
  test('publishes ready evidence on the first completed frame', () => {
    const completed = createCompletedFrameHeartbeat({ heartbeatMs: 100, sampleMs: 1000 });

    expect(completed(0)).toEqual({ fps: 0, sentinel: 1 });
    expect(completed(99)).toBeUndefined();
    expect(completed(100)).toEqual({ fps: 0, sentinel: 2 });
    expect(completed(1000)).toEqual({ fps: 4, sentinel: 3 });
  });

  test('keeps heartbeat identity monotonic while sampling frame throughput', () => {
    const completed = createCompletedFrameHeartbeat({ heartbeatMs: 10, sampleMs: 20 });

    expect(completed(0)).toEqual({ fps: 0, sentinel: 1 });
    expect(completed(10)).toEqual({ fps: 0, sentinel: 2 });
    expect(completed(20)).toEqual({ fps: 150, sentinel: 3 });
    expect(completed(30)).toEqual({ fps: 150, sentinel: 4 });
    expect(completed(40)).toEqual({ fps: 100, sentinel: 5 });
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
    expect(published).toEqual([{ fps: 0, sentinel: 1 }]);
    now = 1010;
    listener?.();
    expect(published).toEqual([{ fps: 0, sentinel: 1 }, { fps: 0, sentinel: 2 }]);

    unsubscribe();
    expect(listener).toBeUndefined();
  });
});
