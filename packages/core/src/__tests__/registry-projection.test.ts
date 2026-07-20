// w1 — TDD (RED): registry projection derivation + AC-03 two-way falsification.
//
// feat-20260708-editor-io-layer-enrich-registry-action-editgateway M1:
// projectOps(listOps()) is the SSOT-derived, registry-facing manifest view. It
// MUST be a pure map over its input — structurally incapable of fabricating an
// op that isn't already in listOps(). At RED phase io/registry-projection.ts
// does not exist, so the import fails and every test here is red; w3 (impl)
// turns them green.
//
// Constraints from upstream:
//   requirements AC-01: projection derives every id/metadata from listOps,
//                       NO independent op-definition constant table.
//   requirements AC-03: human/AI share one listOps — no registry subset split.
//   North-Star §10 (requirements constraints/assumptions): registry may only
//                       PROJECT ops the gateway already has, never CREATE ops —
//                       the projection
//                       set is built FROM listOps() so ⊇ is true by construction
//                       (research Finding B2 / plan-strategy R-B2).
//   plan-strategy §2 D-1 / D-7: pure function (not gateway method); ProjectedOp
//                       is its own interface that drops OpDescriptor.source.
//
// Anchors:
//   plan-tasks.json w1; plan-strategy §5.3 key test points AC-01 / AC-03.

import { describe, expect, it, beforeAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import { projectOps, type ProjectedOp } from '../io/registry-projection';
import type { OpDescriptor } from '../io/catalog';

// ── Fixture ──────────────────────────────────────────────────────────────────

let gw: EditGateway;

beforeAll(() => {
  gw = new EditGateway(createEditSession());
});

// ── AC-01: projection derives from listOps, ids are a subset (⊇ by construction) ──

describe('AC-01 — projectOps derives id/metadata from listOps (w1, RED)', () => {
  it('every projected id is present in listOps() ids (subset)', () => {
    const listed = gw.listOps();
    const listedIds = new Set(listed.map((o) => o.id));
    const projected = projectOps(listed);
    for (const p of projected) {
      expect(listedIds.has(p.id)).toBe(true);
    }
  });

  it('every listOps id is present in the projection (1:1, no dropped ops)', () => {
    const listed = gw.listOps();
    const projected = projectOps(listed);
    const projectedIds = new Set(projected.map((p) => p.id));
    for (const o of listed) {
      expect(projectedIds.has(o.id)).toBe(true);
    }
  });

  it('projection cardinality equals listOps cardinality (pure map, no add/drop)', () => {
    const listed = gw.listOps();
    expect(projectOps(listed).length).toBe(listed.length);
  });

  it('each projected op carries id/title?/domain/argsSchema derived 1:1 from the descriptor', () => {
    const listed = gw.listOps();
    const byId = new Map(listed.map((o) => [o.id, o]));
    for (const p of projectOps(listed)) {
      const src = byId.get(p.id);
      expect(src).toBeDefined();
      expect(p.domain).toBe(src!.domain);
      expect(p.argsSchema).toEqual(src!.argsSchema);
      expect(p.title).toBe(src!.title);
    }
  });

  it('ProjectedOp drops the internal source field (D-7 — registry-facing view)', () => {
    const projected = projectOps(gw.listOps());
    for (const p of projected) {
      expect(p).not.toHaveProperty('source');
    }
  });
});

// ── AC-03 (true): drop a projected entry — it re-derives from listOps() ───────

describe('AC-03 true branch — a projected entry re-derives from listOps (w1, RED)', () => {
  it('deleting an entry from the projection output can be re-projected back from listOps()', () => {
    const listed = gw.listOps();
    const first = projectOps(listed);
    // Drop one entry from a COPY of the projection output.
    const trimmed = first.slice(1);
    const droppedId = first[0]!.id;
    expect(trimmed.find((p) => p.id === droppedId)).toBeUndefined();
    // Re-project from the unchanged listOps() SSOT — the dropped entry returns.
    const reprojected = projectOps(listed);
    const back = reprojected.find((p) => p.id === droppedId);
    expect(back).toBeDefined();
    expect(back!.domain).toBe(first[0]!.domain);
  });
});

// ── AC-03 (false): projectOps cannot fabricate an id absent from its input ────
// Per R-B2 fallback: if the projection is structurally unable to fabricate an op
// (it only maps its input), the falsification "false" branch is proven by feeding
// a strict SUBSET and asserting the output never contains an id outside the input.

describe('AC-03 false branch — projectOps cannot produce an id not in its input (w1, RED)', () => {
  it('feeding a strict subset yields output ids ⊆ that subset (no fabrication)', () => {
    const listed = gw.listOps();
    expect(listed.length).toBeGreaterThan(3);
    const subset = listed.slice(0, 3);
    const subsetIds = new Set(subset.map((o) => o.id));
    const projected = projectOps(subset);
    expect(projected.length).toBe(3);
    for (const p of projected) {
      expect(subsetIds.has(p.id)).toBe(true);
    }
  });

  it('feeding an empty descriptor list yields an empty projection', () => {
    const empty: readonly OpDescriptor[] = [];
    expect(projectOps(empty)).toEqual([]);
  });

  it('a synthetic input id appears in the output only because it was in the input', () => {
    const synthetic: readonly OpDescriptor[] = [
      { id: 'synthetic.only', domain: 'document', argsSchema: null, source: 'builtin', title: 'Synthetic' },
    ];
    const projected = projectOps(synthetic);
    expect(projected.map((p) => p.id)).toEqual(['synthetic.only']);
  });
});

// ── AC-01 structural guard: no inlined op-definition constant table in source ──
// The projection MUST NOT hold its own catalog. A grep over the source file
// asserts it contains none of the builtin op id string literals — the presence
// of any would mean an inlined op-definition table (the exact anti-pattern the
// by-construction guard exists to forbid).

describe('AC-01 source guard — registry-projection.ts has no op-definition constant table (w1, RED)', () => {
  const SRC = path.resolve(import.meta.dir, '..', 'io', 'registry-projection.ts');

  it('the projection source inlines no builtin op id literals', () => {
    const body = readFileSync(SRC, 'utf8');
    const BUILTIN_ID_LITERALS = [
      'spawnEntity', 'destroyEntity', 'setComponent', 'addComponent',
      'setSelection', 'setHoverEntity', 'setAssetSelection',
    ];
    for (const id of BUILTIN_ID_LITERALS) {
      expect(body.includes(`'${id}'`)).toBe(false);
      expect(body.includes(`"${id}"`)).toBe(false);
    }
  });

  it('the projection source declares no local array of op descriptors', () => {
    const body = readFileSync(SRC, 'utf8');
    // An inlined op table would carry a domain string as OBJECT-LITERAL DATA —
    // `domain: 'document',` — comma-terminated inside an entry. A TYPE union
    // declaration (`domain: 'document' | 'session' | 'transient';`, which the
    // ProjectedOp interface legitimately needs) is followed by ` |` or `;`, never
    // a comma. Requiring the comma terminator targets the data-table anti-pattern
    // without flagging the interface's field type.
    expect(/domain:\s*'(document|session|transient)'\s*,/.test(body)).toBe(false);
  });
});
