import { describe, expect, it } from 'bun:test';
import { quat, vec3 } from '@forgeax/engine-math';
import { composeGizmoRotationDelta } from '../viewport-gizmo-rotate-quat';

function eulerDegToQuat(xDeg: number, yDeg: number, zDeg: number): ReturnType<typeof quat.create> {
  const d = Math.PI / 180;
  return quat.fromEuler(quat.create(), xDeg * d, yDeg * d, zDeg * d, 'XYZ');
}

describe('composeGizmoRotationDelta', () => {
  it('matches 90° Y when rotating around world Y from identity', () => {
    const start = quat.identity(quat.create());
    const expected = quat.fromAxisAngle(quat.create(), [0, 1, 0], Math.PI / 2);
    const out = composeGizmoRotationDelta(start, [0, 1, 0], Math.PI / 2);
    expect(Math.abs(quat.dot(out, expected))).toBeCloseTo(1, 5);
  });

  it('does not match euler-component increment after compound rotation', () => {
    const start = eulerDegToQuat(0, 45, 0);
    const localXInWorld = quat.transformVec3(vec3.create(), start, [1, 0, 0]);
    const out = composeGizmoRotationDelta(
      start,
      [localXInWorld[0]!, localXInWorld[1]!, localXInWorld[2]!],
      (30 * Math.PI) / 180,
    );
    const wrong = eulerDegToQuat(30, 45, 0);
    expect(Math.abs(quat.dot(out, wrong))).toBeLessThan(0.999);
  });
});
