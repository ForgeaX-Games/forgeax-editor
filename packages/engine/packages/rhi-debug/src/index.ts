// @forgeax/engine-rhi-debug/src/index.ts — package barrel.

export {
  type CapsMismatchDetail,
  DebugError,
  type DebugErrorCode,
  type DebugErrorDetail,
  type DeterministicViolationDetail,
  type RhiCapsRecordedKey,
} from './errors';
export { pixelDeltaAbsMean } from './pixel-diff';
export {
  type CreateShaderModuleFn,
  type DebugRhiInstance,
  PER_EVENT_OVERHEAD,
  TAPE_FORMAT_VERSION,
  wrap,
  wrapCreateShaderModule,
} from './recorder';
// Inspector exports are NOT re-exported from the barrel to avoid pulling
// pngjs (Node.js dep) into downstream bundles (e.g., the app package).
// Import from '@forgeax/engine-rhi-debug/inspector' for inspector APIs.
export type { Replay } from './replayer';
export { createReplay } from './replayer';
export type { DebugRhiAdapter } from './rpc-bridge';
export { wireDebugRhiInspector } from './rpc-bridge';
export type { PassOffset } from './tape-format';
export {
  computePassOffsets,
  deserializeTape,
  serializeTape,
} from './tape-format';
export type {
  HandleId,
  InspectBindingEntry,
  InspectDrawCall,
  InspectFields,
  InspectReport,
  RhiCallEvent,
  RhiCapsRecorded,
  Tape,
} from './types';
// CLI subcommands (capture-frame / inspect-at) are NOT re-exported from the barrel:
// they depend on inspector-client (WS) and are Node.js-only. Import from
// '@forgeax/engine-rhi-debug/cli' for CLI functions.
