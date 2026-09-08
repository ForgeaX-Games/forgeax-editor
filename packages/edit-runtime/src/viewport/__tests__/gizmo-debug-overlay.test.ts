// gizmo-debug-overlay — frame scheduling contract.
//
// A selection/camera update is not enough for immediate-mode DebugDraw:
// staging is cleared after every render. The overlay producer must therefore be
// registered on Update and run once per editor frame.

import { describe, expect, it } from 'bun:test';
import type { World } from '@forgeax/engine-ecs';

import { installGizmoDebugOverlay } from '../gizmo-debug-overlay';

type CapturedSystem = { readonly fn: () => void };

function makeWorld(systems: CapturedSystem[]): World {
  return {
    addSystem(_phase: unknown, system: CapturedSystem) {
      systems.push(system);
      return { unwrap: () => undefined };
    },
  } as unknown as World;
}

describe('editor Gizmo DebugDraw scheduling', () => {
  it('emits once per Update while editing and skips Play', () => {
    const systems: CapturedSystem[] = [];
    const debugDraw = { line() {}, arrow() {} };
    let editMode = true;
    let draws = 0;

    installGizmoDebugOverlay({
      world: makeWorld(systems),
      debugDraw,
      drawOverlay: () => { draws += 1; },
      isEditMode: () => editMode,
    });

    expect(systems).toHaveLength(1);
    systems[0]!.fn();
    expect(draws).toBe(1);

    editMode = false;
    systems[0]!.fn();
    expect(draws).toBe(1);
  });

  it('tolerates a renderer without DebugDraw', () => {
    const systems: CapturedSystem[] = [];
    let draws = 0;

    installGizmoDebugOverlay({
      world: makeWorld(systems),
      debugDraw: undefined,
      drawOverlay: () => { draws += 1; },
      isEditMode: () => true,
    });

    systems[0]!.fn();
    expect(draws).toBe(0);
  });
});
