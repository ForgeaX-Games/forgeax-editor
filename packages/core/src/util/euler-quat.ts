// euler-quat — editor-side degree adapter over the engine euler↔quat SSOT.
//
// The math is NOT reimplemented here. `@forgeax/engine-math` already owns the
// gimbal-safe, 6-order conversion (euler.fromQuat / quat.fromEuler, Three.js
// intrinsic-rotation + Hamilton convention). This module is a thin boundary
// adapter that translates the engine's (radians, Euler object, XYZ..XZY order)
// surface into the editor's UI contract:
//   - degrees in/out (the Inspector edits degrees)
//   - {rotX, rotY, rotZ} display shape + [qx, qy, qz, qw] tuple
//   - XYZ order pinned in BOTH directions (AGENTS.md #6)
//   - quatToEuler rounds display to 1e-4 for deterministic React state
//
// AGENTS.md #1 / architecture-principles §2 (Derive): the conversion formulas
// have exactly one home — the engine. NEVER hand-roll a second quat↔euler here.
//
// Plan-strategy §2 D-2 (scheme B): quat SSOT in world, euler React state instant.
//
// feat-20260701-editor-world-container-doc-ecs-collapse M3 / AC-22

import { euler, quat } from '@forgeax/engine-math';

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

/** quaternion → euler (XYZ order, degrees).
 *  Rounds to 1e-4 for deterministic display. */
export function quatToEuler(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): { rotX: number; rotY: number; rotZ: number } {
  const e = euler.fromQuat(euler.create(), [qx, qy, qz, qw], 'XYZ');
  const deg = (r: number) => Math.round(r * RAD2DEG * 1e4) / 1e4;
  return { rotX: deg(e.x), rotY: deg(e.y), rotZ: deg(e.z) };
}

/** euler (XYZ order, degrees) → quaternion [qx, qy, qz, qw]. */
export function eulerToQuat(
  rx: number,
  ry: number,
  rz: number,
): [number, number, number, number] {
  const q = quat.fromEuler(
    quat.create(),
    rx * DEG2RAD,
    ry * DEG2RAD,
    rz * DEG2RAD,
    'XYZ',
  );
  return [q[0] as number, q[1] as number, q[2] as number, q[3] as number];
}
