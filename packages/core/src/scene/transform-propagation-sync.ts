import type { World } from '@forgeax/engine-ecs';
import { propagateTransforms } from '@forgeax/engine-scene';
import type { EditorOp } from '../types';

/** True when a committed document op can change derived Transform.world matrices. */
export function opAffectsWorldTransform(op: EditorOp): boolean {
  switch (op.kind) {
    case 'setComponent':
      return op.component === 'Transform';
    case 'reparent':
      return true;
    case 'transaction': {
      const commands = (op as Extract<EditorOp, { kind: 'transaction' }>).commands;
      return commands.some(opAffectsWorldTransform);
    }
    default:
      return false;
  }
}

/** Keep Transform.world in sync immediately after authored transform writes.
 *  Viewport drag previews already call propagateTransforms; Inspector and other
 *  gateway document paths must do the same so the renderer never reads a stale
 *  world matrix between the write and the next frame-loop update. */
export function syncWorldTransformsAfterWrite(world: World, op: EditorOp): void {
  if (!opAffectsWorldTransform(op)) return;
  const result = propagateTransforms(world);
  if (!result.ok) {
    console.warn('[editor-core] propagateTransforms after transform write failed', result.error);
  }
}
