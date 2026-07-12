// @forgeax/editor-core — io/gateway-query.ts
//
// The querySnapshot read-side ASSEMBLY, sunk out of io/gateway.ts. This is the
// wiring that binds the pure `querySnapshot(world, descriptor)` reader (in
// io/query-snapshot.ts) to a gateway's live world — NOT the public entry method.
//
// ── What lives here (and why it is NOT entry semantics) ──────────────────────
// gateway.ts assembled `(desc) => querySnapshot(this.doc.world!, desc)` in FIVE
// places (buildQueryFn, _buildCtx, _buildDocCtx, and both defineOp paths). That
// closure is read-only plumbing — it mutates nothing, routes no command, decides
// no domain. Sinking it into one `makeQueryFn(getWorld)` factory here removes the
// five-way duplication and leaves gateway.ts with only its dispatch/apply/ledger
// narrative. The PUBLIC `EditGateway.buildQueryFn()` method stays in gateway.ts
// (frozen surface, AC-03); its body now simply delegates to this factory, so the
// entry face is byte-identical while the assembly detail lives here (AC-04).
//
// ── Anchors (AC-07 / plan-strategy §2 D-6, bidirectional) ────────────────────
// FORWARD  → this loop: feat-20260709-editor-large-file-di-decompose-wave2-c-
//            domain-scen, M3 w10; requirements AC-03 (buildQueryFn signature
//            frozen) + AC-04 (only assembly detail sinks) + AC-08 (core
//            max_file_loc down); plan-strategy §2 D-4 (querySnapshot assembly is
//            a sink candidate) + §8 (querySnapshot self-introspection unimpaired).
// BACKWARD → querySnapshot landed with defineOp/plan(query,args) in #61
//            (feat-...-op-gateway-single-entry, M4 buildQueryFn); the read-side
//            reader itself is io/query-snapshot.ts. This move is pure relocation
//            of the world-binding closure, no behavior change (git log
//            packages/core/src/io/gateway.ts).

import { querySnapshot } from './query-snapshot';
import type {
  QuerySnapshotDescriptor,
  QuerySnapshotFn,
  QuerySnapshotResult,
} from './query-snapshot';
import type { World } from '@forgeax/engine-ecs';

/**
 * Build a QuerySnapshotFn bound to a live world accessor.
 *
 * `getWorld` is called PER query (not captured once) so the returned fn always
 * reads the gateway's CURRENT world — surviving world swaps (boot injection /
 * scene replaceDoc) and the ▶/■ play-world fork: gateway callers pass
 * `() => this.activeWorld`, so during play `query` reads the live play world and
 * in edit reads `doc.world`. The non-null assertion parity: callers reach this
 * only after a world is present (activeWorld falls back to doc.world when no play
 * world is set); a null world would throw inside `querySnapshot` the same way the
 * inline `this.doc.world!` did (behavior-identical, no new guard — OOS-1).
 */
export function makeQueryFn(getWorld: () => World | undefined): QuerySnapshotFn {
  return (descriptor: QuerySnapshotDescriptor): QuerySnapshotResult =>
    querySnapshot(getWorld()!, descriptor);
}
