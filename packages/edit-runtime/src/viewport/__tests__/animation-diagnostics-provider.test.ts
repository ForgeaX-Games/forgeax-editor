import { describe, expect, it } from 'bun:test';
import type { AnimationDiagnostic, AnimationDiagnosticListener } from '@forgeax/engine-animation';
import { World } from '@forgeax/engine-ecs';

import { createAnimationDiagnosticsProvider } from '../animation-diagnostics-provider';

describe('animation diagnostics provider', () => {
  it('groups channel failures by player and target with locator refs and recovery operations', () => {
    const world = new World();
    let emit: AnimationDiagnosticListener | undefined;
    const bridge = createAnimationDiagnosticsProvider({
      getActiveWorld: () => world,
      subscribe: (listener) => {
        emit = listener;
        return () => { emit = undefined; };
      },
    });
    const base = {
      code: 'animation-target-missing',
      hint: 'Bind the clip target before playback.',
    } as const;
    const diagnostic = (clip: number, channel: number): AnimationDiagnostic => ({
      ...base,
      detail: { player: 7, clip, channel, targetId: 'hips', reason: 'target-missing' },
    });

    emit?.(world, diagnostic(1, 10));
    emit?.(world, diagnostic(2, 11));

    expect(bridge.provider.snapshot()).toMatchObject([{
      id: 'animation:7:hips:target-missing',
      code: 'animation-target-missing',
      subjectRef: { kind: 'entity-handle', id: '7' },
      objectRefs: { entity: { kind: 'entity-handle', id: '7' } },
      recoveryActions: ['setSelection', 'setComponent', 'query'],
      detail: {
        player: 7,
        targetId: 'hips',
        clips: [1, 2],
        channels: [10, 11],
        uniqueChannels: 2,
      },
    }]);
    bridge.dispose();
    expect(emit).toBeUndefined();
  });

  it('projects only diagnostics from the currently active world', () => {
    const editWorld = new World();
    const playWorld = new World();
    let active = editWorld;
    let emit: AnimationDiagnosticListener | undefined;
    const bridge = createAnimationDiagnosticsProvider({
      getActiveWorld: () => active,
      subscribe: (listener) => {
        emit = listener;
        return () => { emit = undefined; };
      },
    });
    const fact: AnimationDiagnostic = {
      code: 'animation-channel-missing',
      hint: 'Rebind the animation channel.',
      detail: { player: 3, clip: 4, channel: 5, targetId: 'root', reason: 'channel-missing' },
    };
    emit?.(editWorld, fact);
    expect(bridge.provider.snapshot()).toHaveLength(1);
    active = playWorld;
    expect(bridge.provider.snapshot()).toHaveLength(0);
    emit?.(playWorld, fact);
    expect(bridge.provider.snapshot()).toHaveLength(1);
    bridge.dispose();
  });
});
