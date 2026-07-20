// io/registry-projection.ts — registry-facing manifest view, derived from listOps.
//
// feat-20260708-editor-io-layer-enrich-registry-action-editgateway M1:
// `projectOps` is the SINGLE structural guard that closes the "human has the
// full op set, AI has a registered subset" split forever. It is a PURE MAP over
// its input: every ProjectedOp is built field-by-field from an OpDescriptor the
// gateway already exposes via listOps(). It holds NO independent op-definition
// constant table, so it is structurally incapable of fabricating an op that
// isn't already in listOps() — the ⊇ relation is true BY CONSTRUCTION.
//
// The registry consumes this as `projectOps(gateway.listOps())`. Because the
// input is the listOps() SSOT, the projection can never drift into a subset or
// invent capabilities the gateway does not know.
//
// ProjectedOp is its OWN interface (not a re-use of OpDescriptor): it is the
// registry-facing view, so it selects id/title/domain/argsSchema and explicitly
// DROPS the internal `source` field (builtin vs defined is a catalog-internal
// distinction, not a registry concern). It is also the seam a future
// capability/trust overlay would layer onto (interface/studio host, OOS-3) —
// deliberately NOT built in this loop.
//
// Anchors:
//   requirements AC-01: projection derives every id/metadata from listOps,
//                       NO independent op-definition constant table.
//   requirements AC-03: human/AI share one listOps — no registry subset split.
//   requirements AC-09 (projection side): descriptor.domain / .argsSchema flow
//                       without `as` — the map body needs no type assertion.
//   North-Star §10 (requirements constraints/assumptions): registry may only
//                       PROJECT, never CREATE ops.
//   plan-strategy §2 D-1 (pure function, not gateway method) + D-7 (own
//                       interface, drops source) + §2.5 (io/ landing).

import type { OpDescriptor, ArgsSchema } from './catalog';

/**
 * Registry-facing projection of a single operation.
 *
 * Derived 1:1 from {@link OpDescriptor} minus the catalog-internal `source`
 * field. This is the view a registry (command palette / AI manifest) sees; it is
 * intentionally a distinct interface so a future capability/trust overlay can be
 * layered here (OOS-3) without touching the gateway's own OpDescriptor.
 */
export interface ProjectedOp {
  readonly id: string;
  readonly domain: 'document' | 'session' | 'transient';
  readonly argsSchema: ArgsSchema | null;
  readonly title?: string;
}

/**
 * Project the gateway's op catalog into the registry-facing manifest view.
 *
 * PURE MAP — every output entry is derived from an input descriptor; the
 * function holds no op-definition table, so it cannot produce an id that was not
 * in `ops`. Feed it `gateway.listOps()` and the projection is a lossless
 * (minus `source`) 1:1 view of the SSOT.
 *
 * @param ops the descriptors from `gateway.listOps()` (the catalog SSOT).
 * @returns a readonly ProjectedOp[] whose ids are a subset-by-construction of
 *          the input ids.
 */
export function projectOps(ops: readonly OpDescriptor[]): readonly ProjectedOp[] {
  return ops.map((descriptor) => {
    // Field-by-field derive. descriptor.domain / .argsSchema flow with no `as`
    // (AC-09 projection side). `source` is deliberately omitted (D-7).
    const projected: ProjectedOp = {
      id: descriptor.id,
      domain: descriptor.domain,
      argsSchema: descriptor.argsSchema,
      ...(descriptor.title !== undefined ? { title: descriptor.title } : {}),
    };
    return projected;
  });
}
