// editor-facts bus contract — the read-side view models + topic names for the
// footer's Events / Diagnostics panels.
//
// Data-plane wiring (ADR-0030 §4): the footer panels live in interface but the
// truth (editor gateway operation runs + engine/scene/asset facts) lives in the
// studio/editor realm, which interface must never import. So studio (the owner
// of the editor realm) publishes onto the shared cross-app bus with `retain`,
// and these interface panels subscribe. interface only knows these flat view
// models — nothing about the editor transport, gateway, or `@forgeax/editor`.
//
// The topic strings are exported so the studio publisher imports the SAME names
// (single source of truth). interface's own `BusTopics` stays empty per the bus
// design; the studio publisher does the `declare module` augmentation next to
// its `publish()` calls.

import { useBusSnapshot } from './use-bus-snapshot';

/** One editor gateway operation dispatch (the "事件" feed row). */
export interface GatewayRun {
  readonly runId: string;
  /** e.g. "document.edit" / "asset.import". */
  readonly operationId: string;
  /** "succeeded" | "failed" | "running" | … (kept open — carrier owns the set). */
  readonly status: string;
  /** epoch ms; 0 when the carrier didn't stamp one. */
  readonly ts: number;
  readonly error?: string;
}

/** Live engine / project / scene / asset facts (the diagnostics popover). */
export interface EditorFacts {
  /** Runtime identity, e.g. "game-runtime/v1 · browser". */
  readonly engine: string;
  /** Active game slug. */
  readonly project: string;
  /** Current scene id/name. */
  readonly scene: string;
  readonly assets: number;
}

export const EDITOR_RUNS_TOPIC = 'editor:gatewayRuns';
export const EDITOR_FACTS_TOPIC = 'editor:facts';

/** Subscribe to the latest gateway-run feed (empty until studio publishes). */
export function useGatewayRuns(): readonly GatewayRun[] {
  return (useBusSnapshot(EDITOR_RUNS_TOPIC) as readonly GatewayRun[] | undefined) ?? [];
}

/** Subscribe to the latest editor facts (undefined until studio publishes). */
export function useEditorFacts(): EditorFacts | undefined {
  return useBusSnapshot(EDITOR_FACTS_TOPIC) as EditorFacts | undefined;
}
