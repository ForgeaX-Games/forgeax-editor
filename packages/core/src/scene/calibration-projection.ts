// calibration-projection — the derived JSON projection of socket + facing
// calibration data (socket-calibration M2, doc §3.6 数据导出 / §5 数据模型).
//
// The authoritative source of truth is the scene itself: a socket is a prop
// (ChildOf a bone + Transform), facing correction is a pivot entity (Name +
// Transform) above the joint root. This module PROJECTS that authored scene
// state into a pure-numeric JSON POD — decoupled from art assets (no binary
// refs) and from runtime logic (no engine handles) — for one-click copy into
// external tools. It is NOT a round-trippable authoritative format: the
// scene-pack remains the SSOT (AGENTS.md anti-pattern #3 — output is a scene,
// not a sidecar; the projection is a read-only convenience view of it).
//
// Pure read over `gateway.activeWorld`; writes nothing.

import type { World } from '@forgeax/engine-ecs';
import { entComponent, entName, worldEntityHandles } from '../store/entity-state';
import { listSkinSockets, readFacingYaw } from './skin-joints';

/** A single socket (prop-on-bone) in the projection: the bone name + the prop's
 *  local TRS relative to that bone (the authored socket transform). */
export interface CalibrationSocketProjection {
  readonly bone: string;
  readonly name: string;
  readonly pos: readonly [number, number, number];
  readonly quat: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
}

/** One skinned character's calibration projection: its name, facing yaw (null
 *  when no FacingPivot exists — no correction authored), and its sockets. */
export interface CalibrationCharacterProjection {
  readonly name: string;
  readonly facingYawDeg: number | null;
  readonly sockets: readonly CalibrationSocketProjection[];
}

/** The full calibration projection across every skinned character in the scene.
 *  Pure numeric values + names; no entity handles, no asset GUIDs — safe to copy
 *  into any external tool. */
export interface CalibrationProjection {
  readonly schemaVersion: 'calibration-v1';
  readonly characters: readonly CalibrationCharacterProjection[];
}

/** Project the calibration state of every skinned character in `world` into a
 *  pure-numeric JSON POD. Iterates all live entities, keeps those carrying a
 *  `Skin` component, and per character emits: its Name, the facing yaw (Y euler
 *  degrees of the FacingPivot above its joint root, or null when none), and its
 *  sockets (each prop-on-bone with local TRS). Returns an empty `characters`
 *  list when the scene has no skinned characters. */
export function summarizeCalibration(world: World): CalibrationProjection {
  const characters: CalibrationCharacterProjection[] = [];
  for (const handle of worldEntityHandles(world)) {
    if (!entComponent(world, handle, 'Skin').ok) continue;
    const sockets = listSkinSockets(world, handle).map((s) => ({
      bone: s.boneName,
      name: s.propName,
      pos: s.pos,
      quat: s.quat,
      scale: s.scale,
    }));
    characters.push({
      name: entName(world, handle),
      facingYawDeg: readFacingYaw(world, handle),
      sockets,
    });
  }
  return { schemaVersion: 'calibration-v1', characters };
}
