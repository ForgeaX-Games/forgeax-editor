// m4-w1 — TDD: listOps field completeness + builtin full-coverage test (RED phase)
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M4:
// Tests for gateway.listOps() return data. At RED phase, catalog.ts is a
// stub — no builtin ops registered, so listOps() returns []. m4-w5 (impl)
// registers all builtin ops and makes these tests green.
//
// Constraints:
//   plan-strategy §2 D-3: listOps returns {id,domain,argsSchema,source,title?}
//   requirements AC-04: listOps single self-describing, full builtin coverage
//   plan-strategy §8 API: listOps returns plain data, one call → full capability set

import { describe, expect, it, beforeAll } from 'bun:test';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';

// ── Fixture ────────────────────────────────────────────────────────────────

let gw: EditGateway;

beforeAll(() => {
  gw = new EditGateway(createEditSession());
});

// ── (a) Return array, each item has id/domain/argsSchema/source non-empty ──

describe('listOps field completeness (m4-w1, RED)', () => {
  it('returns an array', () => {
    const ops = gw.listOps();
    expect(Array.isArray(ops)).toBe(true);
  });

  it('every entry has id (non-empty string)', () => {
    const ops = gw.listOps();
    for (const op of ops) {
      expect(typeof op.id).toBe('string');
      expect(op.id.length).toBeGreaterThan(0);
    }
  });

  it('every entry has domain ∈ {document,session,transient}', () => {
    const ops = gw.listOps();
    for (const op of ops) {
      expect(['document', 'session', 'transient']).toContain(op.domain);
    }
  });

  // argsSchema may be null (some ops have no args)
  it('every entry has argsSchema field (nullable)', () => {
    const ops = gw.listOps();
    for (const op of ops) {
      expect(op).toHaveProperty('argsSchema');
    }
  });

  it('every entry has source ∈ {builtin,defined}', () => {
    const ops = gw.listOps();
    for (const op of ops) {
      expect(['builtin', 'defined']).toContain(op.source);
    }
  });
});

// ── (b) source only 'builtin' or 'defined' ──

describe('listOps source validation (m4-w1, RED)', () => {
  it('all builtins have source builtin', () => {
    const ops = gw.listOps();
    for (const op of ops) {
      if (op.source !== 'defined') {
        expect(op.source).toBe('builtin');
      }
    }
  });
});

// ── (c) builtin full coverage: document 9 + session + transient ──

describe('listOps builtin full coverage (m4-w1, RED)', () => {
  const DOCUMENT_9 = [
    'spawnEntity', 'destroyEntity', 'rename', 'reparent',
    'setComponent', 'addComponent', 'removeComponent', 'setHidden', 'transaction',
  ];

  const SESSION_OPS = [
    'setSelection', 'toggleSelection', 'setSelectionMany',
    'setGizmoMode', 'requestFrame', 'requestRename',
    'setSceneId', 'switchSceneFile', 'createSceneFile',
    'saveDocToDisk', 'loadDocFromDisk',
    // keyboard-router convergence (M1/M4): setAssetSelection migrated transient→session;
    // setAssetSelectionOne is its sugar alias; setDisplay is the scene⇄game toggle.
    'setAssetSelection', 'setAssetSelectionOne', 'setDisplay',
  ];

  const TRANSIENT_OPS = [
    'setHoverEntity', 'setFieldPreview',
  ];

  it('includes all 9 document primitives', () => {
    const ops = gw.listOps();
    const ids = new Set(ops.map((o) => o.id));
    for (const kind of DOCUMENT_9) {
      expect(ids.has(kind)).toBe(true);
    }
  });

  it('includes all session ops', () => {
    const ops = gw.listOps();
    const ids = new Set(ops.map((o) => o.id));
    for (const kind of SESSION_OPS) {
      expect(ids.has(kind)).toBe(true);
    }
  });

  it('includes all transient ops', () => {
    const ops = gw.listOps();
    const ids = new Set(ops.map((o) => o.id));
    for (const kind of TRANSIENT_OPS) {
      expect(ids.has(kind)).toBe(true);
    }
  });

  it('document ops are domain=document', () => {
    const ops = gw.listOps();
    for (const kind of DOCUMENT_9) {
      const op = ops.find((o) => o.id === kind);
      expect(op?.domain).toBe('document');
    }
  });

  it('session ops are domain=session', () => {
    const ops = gw.listOps();
    for (const kind of SESSION_OPS) {
      const op = ops.find((o) => o.id === kind);
      expect(op?.domain).toBe('session');
    }
  });

  it('transient ops are domain=transient', () => {
    const ops = gw.listOps();
    for (const kind of TRANSIENT_OPS) {
      const op = ops.find((o) => o.id === kind);
      expect(op?.domain).toBe('transient');
    }
  });
});

// ── (d) Session/transient counts match M2 consolidation surface ──

describe('listOps counts match M2 consolidation (m4-w1, RED)', () => {
  it('session op count >= 11 (M2 consolidated)', () => {
    const ops = gw.listOps();
    const sessionCount = ops.filter((o) => o.domain === 'session').length;
    expect(sessionCount).toBeGreaterThanOrEqual(11);
  });

  it('transient op count >= 2', () => {
    const ops = gw.listOps();
    const transientCount = ops.filter((o) => o.domain === 'transient').length;
    expect(transientCount).toBeGreaterThanOrEqual(2);
  });

  it('document op count >= 9', () => {
    const ops = gw.listOps();
    const docCount = ops.filter((o) => o.domain === 'document').length;
    expect(docCount).toBeGreaterThanOrEqual(9);
  });
});

// ── (e) title field is optional ──

describe('listOps title field (m4-w1, RED)', () => {
  it('title field can be absent or string', () => {
    const ops = gw.listOps();
    for (const op of ops) {
      if (op.title !== undefined) {
        expect(typeof op.title).toBe('string');
      }
      // absent title is fine — optional field
    }
  });
});

// ── (f) argsSchema is plain JSON object (JSON round-trip safe) ──

describe('argsSchema plain JSON safety (m4-w1, RED)', () => {
  it('each non-null argsSchema survives JSON round-trip', () => {
    const ops = gw.listOps();
    for (const op of ops) {
      if (op.argsSchema !== null) {
        const json = JSON.stringify(op.argsSchema);
        const back = JSON.parse(json);
        expect(back).toEqual(op.argsSchema);
      }
    }
  });
});

// ── (g) transaction forward-reference contract is PROJECTED to AI (solo round-23) ──
// The transaction op promises "forward-references work"; the mechanism (a negative
// `_id` on a spawn, referenced as a later sub-op's `parent`) must be discoverable in
// the listOps() schema an AI reads — not a code-only secret. These lock the projection
// so the contract can't silently rot back to "promised but undocumented".
describe('transaction forward-reference contract is projected (solo round-23)', () => {
  const byId = () => Object.fromEntries(gw.listOps().map((o) => [o.id, o]));

  it('spawnEntity argsSchema declares the `_id` forward-reference placeholder', () => {
    const spawn = byId()['spawnEntity'];
    expect(spawn).toBeDefined();
    const props = (spawn!.argsSchema as { properties?: Record<string, { description?: string }> }).properties;
    expect(props).toBeDefined();
    expect(props).toHaveProperty('_id');
    // description mentions the negative-placeholder + transaction convention
    expect(props!['_id']!.description ?? '').toMatch(/negative|forward-ref/i);
  });

  it('transaction.commands description names the concrete forward-ref mechanism (not just "it works")', () => {
    const tx = byId()['transaction'];
    expect(tx).toBeDefined();
    const desc = (tx!.argsSchema as { properties: { commands: { description: string } } }).properties.commands.description;
    expect(desc).toMatch(/_id/);            // names the field
    expect(desc).toMatch(/negative/i);      // names the convention
    expect(desc).toMatch(/created/);        // points at the result.created[] read-back
  });
});