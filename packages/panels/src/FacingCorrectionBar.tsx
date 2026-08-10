// FacingCorrectionBar — the bespoke Inspector editor for facing calibration
// (socket-calibration M2, doc §3.4 朝向标定 + §3.6 数据导出).
//
// Surfaces a yaw slider on a skinned character's Skin section: it yaws the
// whole model by parenting the joint root under a dedicated `FacingPivot`
// entity and writing a pure-yaw Transform on that pivot (the engine's own
// rig-driving contract, skin.ts:45-46 — the Skin entity's Transform is
// ignored at render, so the pivot MUST sit above the joint root). Every write
// is a `setFacingYaw` dispatch (invariant 7: write = dispatch; one undo step),
// and the pivot is created on first edit through `ensureFacingPivot` when one
// does not yet exist. A "Copy calibration JSON" button projects the authored
// socket + facing state of the whole scene into pure-numeric JSON (derived
// projection — scene-pack stays the SSOT).
//
// This component holds no state and writes no world directly. It re-renders
// with the Inspector (worldGeneration), so a yaw edit or a reparent from
// elsewhere is reflected here without polling.

import {
  gateway,
  readFacingYaw,
  setFacingYaw,
  summarizeCalibration,
} from '@forgeax/editor-core';
import type { BespokeEditorProps } from './bespoke-editors';

export default function FacingCorrectionBar({ entity }: BespokeEditorProps) {
  const world = gateway.activeWorld;
  // No yaw to show until a pivot exists; still render the row so the user can
  // author one by dragging the slider (which calls ensureFacingPivot).
  const yaw = world === null ? null : readFacingYaw(world, entity);
  const yawDeg = yaw ?? 0;

  const onYaw = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) setFacingYaw(entity, v);
  };

  const onCopy = (): void => {
    if (world === null) return;
    const proj = summarizeCalibration(world);
    void navigator.clipboard?.writeText(JSON.stringify(proj, null, 2));
  };

  return (
    <div className="facing-calib" data-testid={`facing-calib-${entity}`}>
      <div className="facing-calib-row">
        <span className="facing-calib-label">Facing Yaw°</span>
        <input
          className="facing-calib-range"
          data-testid="facing-calib-yaw-range"
          type="range"
          min={-180}
          max={180}
          step={1}
          value={yawDeg}
          onChange={onYaw}
        />
        <input
          className="facing-calib-num"
          data-testid="facing-calib-yaw-num"
          type="number"
          min={-180}
          max={180}
          step={1}
          value={yawDeg}
          onChange={onYaw}
        />
      </div>
      <button
        type="button"
        className="facing-calib-copy"
        data-testid="facing-calib-copy"
        onClick={onCopy}
      >
        Copy calibration JSON
      </button>
    </div>
  );
}
