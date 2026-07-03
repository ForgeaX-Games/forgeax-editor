// euler-quat — authoritative XYZ-order euler↔quat conversion (SSOT for whole editor)
//
// Extracted from scene-pack.ts:139-161 (verified implementation). All editor
// consumers (Inspector, scene-pack, tests) import this module — NEVER write a
// second quat→euler or euler→quat anywhere else.
//
// AGENTS.md #6 (cross-repo unit/order convention): conversion happens ON THE
// EDITOR SIDE. Order is XYZ (both directions). The engine `Transform` stores
// quatX/Y/Z/W; euler is a transient React state in the Inspector only.
//
// Plan-strategy §2 D-2 (scheme B): quat SSOT in world, euler React state instant.
//
// feat-20260701-editor-world-container-doc-ecs-collapse M3 / AC-22

/** quaternion → euler (XYZ order, degrees).
 *  Uses internal rounding to 1e-4 for deterministic display. */
export function quatToEuler(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): { rotX: number; rotY: number; rotZ: number } {
  const sinr = 2 * (qw * qx + qy * qz);
  const cosr = 1 - 2 * (qx * qx + qy * qy);
  const rx = Math.atan2(sinr, cosr);
  const sinp = 2 * (qw * qy - qz * qx);
  const ry =
    Math.abs(sinp) >= 1 ? (Math.sign(sinp) * Math.PI) / 2 : Math.asin(sinp);
  const siny = 2 * (qw * qz + qx * qy);
  const cosy = 1 - 2 * (qy * qy + qz * qz);
  const rz = Math.atan2(siny, cosy);
  const deg = (r: number) => Math.round((r * 180) / Math.PI * 1e4) / 1e4;
  return { rotX: deg(rx), rotY: deg(ry), rotZ: deg(rz) };
}

const DEG2RAD = Math.PI / 180;

/** euler (XYZ order, degrees) → quaternion [qx, qy, qz, qw]. */
export function eulerToQuat(
  rx: number,
  ry: number,
  rz: number,
): [number, number, number, number] {
  const cx = Math.cos((rx * DEG2RAD) / 2);
  const sx = Math.sin((rx * DEG2RAD) / 2);
  const cy = Math.cos((ry * DEG2RAD) / 2);
  const sy = Math.sin((ry * DEG2RAD) / 2);
  const cz = Math.cos((rz * DEG2RAD) / 2);
  const sz = Math.sin((rz * DEG2RAD) / 2);
  // XYZ order
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}