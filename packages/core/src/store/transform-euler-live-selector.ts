// transform-euler-live-selector — one RuntimeUiGraph mount for Transform rotation
// display (Scheme B / inspector-transform-live-sync.md §6 B).
//
// quat is SSOT on the entity; Inspector shows XYZ euler degrees. This factory
// composes createInspectorFieldSelector so quat→euler runs once per graph
// publish, not once per axis ScrubInput.

import type { RuntimeUiGraph } from '../io/runtime-ui-diagnostics';
import { quatToEuler } from '../util/euler-quat';
import { createInspectorFieldSelector, type InspectorFieldSelector } from './live-world-field-selectors';

export type TransformEulerDegrees = {
  readonly rotX: number;
  readonly rotY: number;
  readonly rotZ: number;
};

export interface TransformEulerLiveSelectorOptions {
  readonly entity: number;
  /** Read local Transform.quat as [x, y, z, w]. Throws if unavailable. */
  readonly readQuat: (world: unknown, entity: number) => readonly [number, number, number, number];
}

const EULER_POD_SHAPE = {
  kind: 'pod' as const,
  fields: {
    rotX: { kind: 'primitive' as const },
    rotY: { kind: 'primitive' as const },
    rotZ: { kind: 'primitive' as const },
  },
};

export function mountTransformEulerLiveSelector(
  graph: RuntimeUiGraph,
  options: TransformEulerLiveSelectorOptions,
): InspectorFieldSelector<TransformEulerDegrees> {
  return createInspectorFieldSelector<TransformEulerDegrees>(graph, {
    entity: options.entity,
    component: 'Transform',
    field: 'eulerDeg',
    shape: EULER_POD_SHAPE,
    read: (world, entity) => {
      const [qx, qy, qz, qw] = options.readQuat(world, entity);
      return quatToEuler(qx, qy, qz, qw);
    },
  });
}
