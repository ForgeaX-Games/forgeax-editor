import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { FrameEnd } from '@forgeax/engine-ecs';
import { createLiveWorldFrameEndPublisher } from '../run-lifecycle';

const hostSessionSource = readFileSync(resolve(import.meta.dir, '..', 'host-session.ts'), 'utf8');

describe('runtime broadcast cutover safety net', () => {
  it('creates exactly one graph opportunity for one outer update', () => {
    let published = 0;
    let frameEndSystem: (() => void) | undefined;
    const world = {
      addSystem: (schedule: typeof FrameEnd, descriptor: { name: string; fn: () => void }) => {
        expect(schedule).toBe(FrameEnd);
        expect(descriptor.name).toBe('editor-runtime-ui-publisher');
        frameEndSystem = descriptor.fn;
        return { ok: true as const };
      },
      removeSystem: () => ({ ok: true as const }),
    };
    const publisher = createLiveWorldFrameEndPublisher({
      bindWorld: () => 1,
      unbindWorld: () => true,
      publish: () => {
        published += 1;
        return 'published' as const;
      },
    });

    publisher.bind(world);
    expect(published).toBe(0);
    frameEndSystem?.();
    expect(published).toBe(1);
    expect(frameEndSystem).toBeDefined();
  });

  it('keeps the pre-cutover runtime call-chain bounded for the migration gate', () => {
    const runtimeCallCount = hostSessionSource.split('notifyDocChanged();').length - 1;
    expect(runtimeCallCount).toBeLessThanOrEqual(1);
    expect(hostSessionSource).toContain('onPlayFrame: () => {');
  });
});
