// @forgeax/engine-input -- public surface (charter F2 minimal surface).
//
// AI users:
//   - Build the snapshot Resource via `createFrameStartScanSystem(backend, world)`
//     and add the returned `SystemDescriptor` to the schedule. After
//     `world.update()` runs, read the snapshot through
//     `world.getResource<InputSnapshot>('InputSnapshot')` (or the
//     re-exported `INPUT_SNAPSHOT_RESOURCE_KEY` constant).
//   - In a browser context, attach a PointerLock-aware producer with
//     `attachBrowserInputBackend(canvas)`; the returned callable is
//     both a detach handle and an `InputBackend`.
//   - For headless tests / pre-start fixtures, `createInputSnapshot()`
//     returns an empty snapshot whose accessors all evaluate to false /
//     `{ x: 0, y: 0 }` (charter P3: empty signal is the signal).
//
// Single import path:
//   import {
//     attachBrowserInputBackend,
//     createFrameStartScanSystem,
//     createInputSnapshot,
//     INPUT_SNAPSHOT_RESOURCE_KEY,
//     type InputSnapshot,
//     type InputBackend,
//   } from '@forgeax/engine-input';

export {
  attachBrowserInputBackend,
  type BrowserInputBackendOptions,
} from './browser-backend';
export {
  createFrameStartScanSystem,
  FRAME_START_SCAN_SYSTEM_NAME,
} from './frame-start-scan-system';
export type { InputBackend, InputBackendSample, InputSnapshot } from './input-snapshot';
export {
  createInputSnapshot,
  INPUT_SNAPSHOT_RESOURCE_KEY,
  snapshotFromSample,
} from './input-snapshot';
