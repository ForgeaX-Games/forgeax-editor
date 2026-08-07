// SocketCalibrationBar — the bespoke Inspector editor for socket calibration
// (socket-calibration M1, doc §3.2 绑点标定).
//
// Surfaces the "parent bone" dropdown on a prop's Transform section: it lists
// every joint of the skinned character the prop belongs to and reparents the
// prop to the chosen joint through the ONE `reparentEntity` helper (world-
// preserving, single undo). The dropdown renders ONLY when the entity has a
// Skin ancestor — a loose prop outside any character stays null so the generic
// Transform fields remain the whole story.
//
// Every write is a `reparentEntity` dispatch (north-star §2: write = dispatch);
// this component holds no state and writes no world directly. It re-renders with
// the Inspector (worldGeneration), so a reparent from elsewhere (Hierarchy drag)
// is reflected here without polling.

import { entParent, gateway, listSkinJointsFor, reparentEntity } from '@forgeax/editor-core';
import type { EntityHandle } from '@forgeax/editor-core';
import type { BespokeEditorProps } from './bespoke-editors';

export default function SocketCalibrationBar({ entity }: BespokeEditorProps) {
  const world = gateway.activeWorld;
  const joints = world === null ? [] : listSkinJointsFor(world, entity);
  if (joints.length === 0) return null;

  const curParent = world === null ? null : entParent(world, entity);
  const curHandle = String(curParent ?? '');
  const matched = curParent !== null && joints.some((j) => j.handle === curParent);

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const v = e.target.value;
    if (v === '') return;
    reparentEntity(entity, Number(v) as EntityHandle);
  };

  return (
    <div className="socket-calib" data-testid={`socket-calib-${entity}`}>
      <span className="socket-calib-label">Parent Bone</span>
      <select
        className="socket-calib-select"
        data-testid="socket-calib-bone"
        value={matched ? curHandle : ''}
        onChange={onChange}
      >
        {!matched && <option value="">{curParent === null ? '— none —' : '#'.concat(String(curParent))}</option>}
        {joints.map((j) => (
          <option key={j.handle} value={String(j.handle)}>{j.name}</option>
        ))}
      </select>
    </div>
  );
}
