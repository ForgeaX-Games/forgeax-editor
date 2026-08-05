// viewport-drag-group — multi-selection translate drag (gizmo-ue-parity plan §4.3).
//
// UE parity: dragging the translate gizmo with several entities selected moves
// ALL of them by the same world-space delta. Rotate/scale stay primary-only
// (documented gap — multi-pivot rotate/scale is M5 backlog).
//
// Pure data + injected reader: no direct world/engine imports, so the group
// construction is unit-testable without a DOM or engine World (D-8 style).
// The caller (viewport.ts) supplies the reader that adapts engine reads; the
// one-gesture-one-op commit (a single `transaction` document op) is assembled
// by the caller through the gateway begin/update/commit lifecycle.

import type { EntityHandle } from '@forgeax/engine-ecs';

import type { Vec3 } from './viewport-ray';

/** One entity taking part in a multi-selection translate drag. */
export interface DragGroupMember {
  /** World entity handle (also the op's `entity` id — handle IS identity, M4). */
  id: EntityHandle;
  /** Local Transform snapshot at grab (drag write-back base). */
  origLocal: Record<string, number>;
  /** World-space position at grab — the shared world delta is added to this. */
  origWorld: Vec3;
}

/** What the group builder needs to know about one entity (undefined = the
 *  entity has no Transform or is gone → excluded from the drag). */
export interface DragGroupSeed {
  local: Record<string, number>;
  worldPos: Vec3;
}

/** Build the translate-drag group: the primary first, then every other
 *  selected entity the reader can resolve. Order is stable (primary first)
 *  so the primary stays the Inspector field-preview mirror. */
export function buildDragGroup(
  primary: EntityHandle,
  selection: ReadonlySet<EntityHandle>,
  read: (entity: EntityHandle) => DragGroupSeed | undefined,
): DragGroupMember[] {
  const group: DragGroupMember[] = [];
  const push = (entity: EntityHandle): void => {
    const seed = read(entity);
    if (!seed) return;
    group.push({ id: entity, origLocal: { ...seed.local }, origWorld: [...seed.worldPos] });
  };
  push(primary);
  for (const entity of selection) {
    if (entity === primary) continue;
    push(entity);
  }
  return group;
}

/** World-space target of a member after applying the shared world delta. */
export function translatedMemberTarget(member: DragGroupMember, delta: Vec3): Vec3 {
  return [
    member.origWorld[0] + delta[0],
    member.origWorld[1] + delta[1],
    member.origWorld[2] + delta[2],
  ];
}
