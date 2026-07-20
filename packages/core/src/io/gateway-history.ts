// @forgeax/editor-core — io/gateway-history.ts
//
// EditGateway history/step + op-handle NON-ENTRY implementation detail, sunk out
// of io/gateway.ts so the gateway file keeps ONLY its single-entry narrative.
//
// ── What lives here (and why it is NOT entry semantics) ──────────────────────
//   CommandOrigin / HistoryStep  — the data TYPES the History panel reads.
//   labelOf / entityOf / step     — pure functions that DERIVE a HistoryStep
//                                   from a command (no gateway state touched).
//   nextOpHandleId                — a pure monotonic id minter for OpHandle.
// None of these route a command, mutate the world, or decide a domain — they are
// the "how a step is shaped / an id is minted" detail, not the "dispatch → apply
// → ledger" entry story. EditGateway imports them; the class body stays the sole
// place that describes WHAT happens on dispatch/begin/commit/undo (AC-04).
//
// ── Anchors (AC-07 / plan-strategy §2 D-6, bidirectional) ────────────────────
// FORWARD  → this loop: feat-20260709-editor-large-file-di-decompose-wave2-c-
//            domain-scen, M3 w10; requirements AC-03 (public face byte-frozen) +
//            AC-04 (only non-entry detail sinks) + AC-08 (core max_file_loc down);
//            plan-strategy §2 D-4 (gateway sinks detail, entry narrative frozen).
// BACKWARD → gateway.ts origin: EditGateway single-entry landed in #61
//            (feat-...-op-gateway-single-entry, three-domain consolidation +
//            catalog/defineOp);
//            IoC ctx + trace spans landed in #72 (feat-20260707-editor-trace-ioc).
//            history/step + OpHandle predate this file inside gateway.ts — this
//            move is pure relocation, no behavior change (git log packages/core/
//            src/io/gateway.ts).

import type { EditorOp } from '../types';

/** Who issued a command — human UI action vs AI tool-call. */
export type CommandOrigin = 'human' | 'ai';

/** One timeline step for the History panel. */
export interface HistoryStep {
  label: string;
  origin: CommandOrigin;
  /** true if this step is currently undone (a redoable "future" step). */
  future: boolean;
  /** the entity this command operated on, if any (for selection sync). */
  entity?: number;
}

/** Derive a human-readable timeline label from a command (kind + component if any). */
export function labelOf(cmd: EditorOp): string {
  return cmd.kind + ('component' in cmd ? ` ${(cmd as { component: string }).component}` : '');
}

/** Derive the entity a command operated on, if any (for selection sync). */
export function entityOf(cmd: EditorOp): number | undefined {
  return 'entity' in cmd ? (cmd as { entity: number }).entity : undefined;
}

/** Build a HistoryStep record (omits `entity` when undefined for a tight shape). */
export function step(
  label: string,
  origin: CommandOrigin,
  future: boolean,
  entity: number | undefined,
): HistoryStep {
  return entity === undefined ? { label, origin, future } : { label, origin, future, entity };
}

let _opHandleCounter = 0;
/** Mint a fresh, process-unique OpHandle id (monotonic, time-seeded). */
export function nextOpHandleId(): string {
  return `op-${Date.now().toString(36)}-${(_opHandleCounter++).toString(36)}`;
}
