// viewport-entity-read.test.ts — UE-parity recursive hide read helpers
// (docs 2026-08-04-editor-hide-ue-parity-plan M1)
//
// Locks isEntEffectivelyHidden: the pick sweep and editor-entity resolution must
// skip entities hidden by an ANCESTOR, not only entities carrying their own
// EditorHidden marker — otherwise a hidden parent's children stay clickable in
// the viewport while the renderer (Disabled marker) already skips them.

import { describe, it, expect } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import { EditorHidden } from '@forgeax/editor-core';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { isEntEffectivelyHidden, isEntHidden } from '../viewport-entity-read';

function spawn(world: World, name: string, parent?: EntityHandle): EntityHandle {
  const r = world.spawn(
    { component: Name, data: { value: name } },
    { component: Transform, data: { pos: [0, 0, 0] } },
    ...(parent !== undefined ? [{ component: ChildOf, data: { parent } }] : []),
  );
  if (!r.ok) throw new Error('spawn failed');
  return r.value;
}

describe('isEntEffectivelyHidden (UE recursive hide)', () => {
  it('entity with its own EditorHidden is hidden (own marker)', () => {
    const world = new World();
    const e = spawn(world, 'A');
    expect(isEntHidden(world, e)).toBe(false);
    expect(isEntEffectivelyHidden(world, e)).toBe(false);
    world.addComponent(e, { component: EditorHidden, data: {} });
    expect(isEntHidden(world, e)).toBe(true);
    expect(isEntEffectivelyHidden(world, e)).toBe(true);
  });

  it('child of a hidden parent is effectively hidden without its own marker', () => {
    const world = new World();
    const parent = spawn(world, 'Parent');
    const child = spawn(world, 'Child', parent);
    const grandchild = spawn(world, 'Grandchild', child);
    world.addComponent(parent, { component: EditorHidden, data: {} });
    expect(isEntHidden(world, child)).toBe(false);
    expect(isEntEffectivelyHidden(world, child)).toBe(true);
    expect(isEntEffectivelyHidden(world, grandchild)).toBe(true);
    expect(isEntEffectivelyHidden(world, parent)).toBe(true);
  });

  it('sibling of a hidden entity stays effectively visible', () => {
    const world = new World();
    const hidden = spawn(world, 'Hidden');
    const sibling = spawn(world, 'Sibling');
    world.addComponent(hidden, { component: EditorHidden, data: {} });
    expect(isEntEffectivelyHidden(world, sibling)).toBe(false);
  });

  it('a ChildOf cycle terminates instead of hanging (defensive)', () => {
    const world = new World();
    const a = spawn(world, 'A');
    const b = spawn(world, 'B', a);
    // Force a pathological cycle: a.parent = b.
    world.set(a, ChildOf, { parent: b });
    expect(isEntEffectivelyHidden(world, a)).toBe(false);
    expect(isEntEffectivelyHidden(world, b)).toBe(false);
  });
});
