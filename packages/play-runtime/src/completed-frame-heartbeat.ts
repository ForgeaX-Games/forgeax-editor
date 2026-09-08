export interface CompletedFrameHeartbeat {
  readonly fps: number;
  readonly sentinel: number;
}

export interface CompletedFrameHeartbeatSource {
  readonly subscribe: (listener: () => void) => () => void;
  readonly now: () => number;
  readonly publish: (heartbeat: CompletedFrameHeartbeat) => void;
  readonly heartbeatMs?: number;
  readonly sampleMs?: number;
}

/**
 * Build a bounded reporter driven only by renderer-completed frames.
 *
 * The first completed frame publishes immediately (fps 0). Studio's Play
 * chrome waits for that first `ready` heartbeat; skipping it left ▶ in place
 * whenever the renderer submitted one frame and then stalled.
 *
 * The caller supplies the completion timestamp so Host and Worker execution
 * lanes share one timing policy without creating another rAF or timer loop.
 */
export function createCompletedFrameHeartbeat(options: {
  readonly heartbeatMs?: number;
  readonly sampleMs?: number;
} = {}): (completedAtMs: number) => CompletedFrameHeartbeat | undefined {
  const heartbeatMs = options.heartbeatMs ?? 100;
  const sampleMs = options.sampleMs ?? 1000;
  let frames = 0;
  let sampleStartedAt: number | undefined;
  let lastHeartbeatAt: number | undefined;
  let lastFps = 0;
  let sentinel = 0;

  return (completedAtMs): CompletedFrameHeartbeat | undefined => {
    frames += 1;
    if (sampleStartedAt === undefined || lastHeartbeatAt === undefined) {
      sampleStartedAt = completedAtMs;
      lastHeartbeatAt = completedAtMs;
      sentinel += 1;
      return { fps: lastFps, sentinel };
    }

    const sampleElapsedMs = completedAtMs - sampleStartedAt;
    if (sampleElapsedMs >= sampleMs) {
      lastFps = Math.round((frames * 1000) / sampleElapsedMs);
      frames = 0;
      sampleStartedAt = completedAtMs;
    }

    if (completedAtMs - lastHeartbeatAt < heartbeatMs) return undefined;
    lastHeartbeatAt = completedAtMs;
    sentinel += 1;
    return { fps: lastFps, sentinel };
  };
}

/** Attach the reporter to the renderer's completed-frame producer. */
export function installCompletedFrameHeartbeat(source: CompletedFrameHeartbeatSource): () => void {
  const completedFrame = createCompletedFrameHeartbeat(source);
  return source.subscribe(() => {
    const heartbeat = completedFrame(source.now());
    if (heartbeat !== undefined) source.publish(heartbeat);
  });
}
