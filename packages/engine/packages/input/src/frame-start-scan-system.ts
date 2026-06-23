// frame-start-scan-system.ts -- bridges an `InputBackend` producer into
// the `InputSnapshot` Resource consumed by user systems (charter P5).
//
// Plan-strategy section 2.10 D-5 locks the system to a frame-start position
// in the schedule: user systems declare `after: ['input-frame-start-scan']`
// to read the snapshot. The system itself holds zero queries; it only
// pulls one sample from the backend and writes the Resource via the
// captured world reference (the schedule does not pass `world` to the
// system fn directly, so the factory closes over it).

import type { SystemDescriptor, World } from '@forgeax/engine-ecs';
import {
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputBackend,
  snapshotFromSample,
} from './input-snapshot';

/**
 * Stable system name (locked by `frame-start-scan-system.test.ts`). User
 * systems reference it through `after: [FRAME_START_SCAN_SYSTEM_NAME]`
 * to ensure they observe the freshly written snapshot.
 */
export const FRAME_START_SCAN_SYSTEM_NAME = 'input-frame-start-scan';

/**
 * Build the frame-start scan `SystemDescriptor`. Each `world.update()`
 * tick:
 *   1. calls `backend.sample()` to drain the backend's per-frame
 *      accumulator (movement delta + up-edge set);
 *   2. derives a fresh `InputSnapshot` via `snapshotFromSample`;
 *   3. writes it under `INPUT_SNAPSHOT_RESOURCE_KEY` via
 *      `world.insertResource` -- idempotent overwrite, charter P4
 *      consistent abstraction (consumers always read the same Resource
 *      key regardless of which backend produced the sample).
 *
 * The factory captures `world` because the schedule's system fn
 * signature is `(queryResults, commands) => void` -- it does not receive
 * a world handle (see `packages/ecs/src/schedule.ts`#runSchedule). A
 * captured reference keeps the consumer surface free of an extra
 * argument (charter F2 minimal surface).
 */
export function createFrameStartScanSystem(
  backend: InputBackend,
  world: Pick<World, 'insertResource'>,
): SystemDescriptor<readonly []> {
  return {
    name: FRAME_START_SCAN_SYSTEM_NAME,
    queries: [] as const,
    fn() {
      const sample = backend.sample();
      const snapshot = snapshotFromSample(sample);
      world.insertResource(INPUT_SNAPSHOT_RESOURCE_KEY, snapshot);
    },
  };
}
