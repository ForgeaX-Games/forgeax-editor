// w5 — TDD (RED): declarative side-effect hints on trace span leaves.
//
// feat-20260708-editor-io-layer-enrich-registry-action-editgateway M2:
// SpanNode.attributes gains a NEW `sideEffects: SideEffectHint[]` slot (the
// existing `engineCalls` array is left untouched — D-3). A SINGLE editor-side
// "engine interface name -> side-effect hint" table (SSOT) lives in
// engine-facade.ts next to _recordLeaf; the leaf-record path derives the hint
// from that table and pushes {engineInterface, hint}, deduped by interface.
//
// At RED phase the `sideEffects` field + the table do not exist yet, so:
//   - reading last().attributes.sideEffects yields undefined -> assertions fail
//   - the source grep for the single `Record<EngineInterfaceName ...>` finds 0
// w6 (field/type) + w7 (table/fill) turn these green.
//
// The hints are an editor-side DECLARATIVE contract description ("by contract
// this interface will trigger ..."), NOT engine real runtime causality
// (OOS-1 stays excluded; D-5 / AGENTS.md anti-pattern #1). This suite asserts
// the hint TEXT is sourced from the table, never that the engine actually
// reacted. Async detached continuations are OOS-2 and are not covered.
//
// Constraints from upstream:
//   requirements AC-06: attributes-layer slot, shape defined by a type.
//   requirements AC-07: ONE mapping table (SSOT), fill traceable to a table
//                       entry, no second Record<EngineInterfaceName,...> copy.
//   requirements AC-08: gateway.trace.last()/recent() leaves carry the hint,
//                       programmatically readable.
//   requirements boundary: missing table entry -> hint omitted, never throws
//                       (sideEffects may be shorter than engineCalls); no active
//                       span -> _recordLeaf stays a no-op.
//   plan-strategy §2 D-3 (new field, engineCalls untouched) / D-4 (table SSOT in
//                       engine-facade.ts) / D-5 (contract-description wording) /
//                       D-8 (dedup key = engineInterface).
//
// Anchors:
//   plan-tasks.json w5; plan-strategy §5.3 key test points AC-06/07/08.

import { describe, expect, it, beforeEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-runtime';
import { EditGateway } from '../io/gateway';
import { registerApplier, sessionAppliers } from '../io/appliers';
import { createEditSession } from '../session/document';
import { EngineFacade } from '../io/engine-facade';
import { activeSpan, type EngineInterfaceName, type SideEffectHint } from '../io/trace';
import type { EditorOp, EditSession } from '../types';

// ── Fixtures ───────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const FACADE_SRC = path.resolve(import.meta.dir, '..', 'io', 'engine-facade.ts');
const TRACE_SRC = path.resolve(import.meta.dir, '..', 'io', 'trace.ts');

const VALID_INTERFACES: ReadonlySet<string> = new Set<EngineInterfaceName>([
  'world.set',
  'world.spawn',
  'world.despawn',
  'world.allocSharedRef',
  'world.addComponent',
  'world.removeComponent',
]);

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

function spawnEntity(gw: EditGateway, name: string): number {
  void Transform;
  const cmd: EditorOp = {
    kind: 'spawnEntity',
    name,
    components: { Transform: { posX: 0, posY: 0, posZ: 0 } },
  };
  const r = gw.dispatch(cmd);
  if (!r.ok) throw new Error(`spawn failed: ${(r as { error?: { hint?: string } }).error?.hint}`);
  return (cmd as unknown as { _id: number })._id;
}

function isSideEffectHint(x: unknown): x is SideEffectHint {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.engineInterface === 'string' && typeof o.hint === 'string';
}

// ── AC-06 / AC-08: leaf carries a well-shaped, non-empty side-effect hint ────

describe('AC-06/08 — span leaf carries side-effect hints (w5, RED)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
  });

  it('spawnEntity dispatch → last().attributes.sideEffects is a non-empty, well-shaped array', () => {
    spawnEntity(gw, 'se-spawn');
    const last = gw.trace.last();
    expect(last).not.toBeNull();
    const se = last!.attributes.sideEffects;
    expect(Array.isArray(se)).toBe(true);
    expect(se.length).toBeGreaterThan(0);
    for (const h of se) {
      expect(isSideEffectHint(h)).toBe(true);
      expect(VALID_INTERFACES.has(h.engineInterface)).toBe(true);
      expect(h.hint.length).toBeGreaterThan(0);
    }
  });

  it('spawnEntity span records a world.spawn side-effect hint', () => {
    spawnEntity(gw, 'se-spawn2');
    const last = gw.trace.last();
    expect(last).not.toBeNull();
    const ifaces = last!.attributes.sideEffects.map((h) => h.engineInterface);
    expect(ifaces).toContain('world.spawn');
  });

  it('setComponent span records a world.set side-effect hint (AC-08 programmatic read)', () => {
    const id = spawnEntity(gw, 'se-set');
    const r = gw.dispatch({
      kind: 'setComponent',
      entity: id,
      component: 'Transform',
      patch: { posY: 9 },
    } as EditorOp);
    expect(r.ok).toBe(true);
    const last = gw.trace.last();
    expect(last).not.toBeNull();
    expect(last!.name).toBe('setComponent');
    const ifaces = last!.attributes.sideEffects.map((h) => h.engineInterface);
    expect(ifaces).toContain('world.set');
  });

  it('recent() leaves also carry side-effect hints (AC-08)', () => {
    spawnEntity(gw, 'se-a');
    spawnEntity(gw, 'se-b');
    const roots = gw.trace.recent(2);
    expect(roots.length).toBe(2);
    for (const root of roots) {
      expect(root.attributes.sideEffects.length).toBeGreaterThan(0);
    }
  });
});

// ── AC-07: single SSOT table + fill traceable to a table entry ───────────────

describe('AC-07 — mapping table is the single SSOT, fill traceable (w5, RED)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
  });

  it('exactly one Record<EngineInterfaceName,...> table DECLARATION exists across packages/core/src', () => {
    // AC-07 falsification target: a SECOND table would be a `const NAME: Record<
    // EngineInterfaceName, ...>` DECLARATION. Match the declaration form (a const
    // typed as the Record — optionally wrapped in `Partial<…>`, since not every
    // EngineInterfaceName carries a hint) so prose mentions of the type in
    // comments/strings — which legitimately reference the SSOT by name — are not
    // counted.
    let out = '';
    try {
      out = execFileSync(
        'git',
        ['grep', '-nP', String.raw`const\s+\w+\s*:\s*(?:Partial<\s*)?Record<\s*EngineInterfaceName`, '--', 'packages/core/src'],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      if (err.status === 1 && !(err.stdout && err.stdout.trim())) out = '';
      else if (err.stdout) out = err.stdout;
      else throw e;
    }
    const hits = out.split('\n').filter((l) => l.trim().length > 0);
    // The map is the SSOT: exactly one declaration, and it lives in engine-facade.ts.
    expect(hits.length).toBe(1);
    expect(hits[0]!).toContain('engine-facade.ts');
  });

  it('trace.ts holds no side-effect mapping table (table SSOT is engine-facade.ts, not duplicated)', () => {
    const body = readFileSync(TRACE_SRC, 'utf8');
    expect(/Record<\s*EngineInterfaceName/.test(body)).toBe(false);
  });

  it('every hint pushed onto a leaf is traceable to a literal in engine-facade.ts source', () => {
    spawnEntity(gw, 'trace-src');
    const last = gw.trace.last();
    expect(last).not.toBeNull();
    const facadeBody = readFileSync(FACADE_SRC, 'utf8');
    expect(last!.attributes.sideEffects.length).toBeGreaterThan(0);
    for (const h of last!.attributes.sideEffects) {
      // The hint text must appear verbatim in the facade source — i.e. it was
      // derived from a table entry there, not fabricated at the call site.
      expect(facadeBody.includes(h.hint)).toBe(true);
    }
  });

  it('each recorded sideEffect interface was actually called (present in engineCalls)', () => {
    const id = spawnEntity(gw, 'derive');
    gw.dispatch({
      kind: 'setComponent',
      entity: id,
      component: 'Transform',
      patch: { posZ: 3 },
    } as EditorOp);
    const last = gw.trace.last();
    expect(last).not.toBeNull();
    const called = new Set(last!.attributes.engineCalls);
    for (const h of last!.attributes.sideEffects) {
      expect(called.has(h.engineInterface)).toBe(true);
    }
  });
});

// ── Boundary: dedup, shorter-than-engineCalls, no active span no-op ───────────

describe('boundary — dedup + graceful defaults (w5, RED)', () => {
  it('same interface called twice in one span → one deduped hint (D-8); sideEffects shorter than engineCalls', () => {
    const gw = new EditGateway(createSession());
    sessionAppliers.delete('dupLeaf302');
    // Document applier gets the ApplierCtx (merged session) as its first arg, so
    // ctx.engine is the EngineFacade. Call spawn twice → engineCalls records two
    // 'world.spawn' entries, but sideEffects must dedup to a single hint.
    registerApplier('document', 'dupLeaf302', function (ctx: unknown, _cmd: EditorOp) {
      const c = ctx as { engine: EngineFacade };
      c.engine.spawn();
      c.engine.spawn();
      return { ok: true as const, inverse: { kind: 'destroyEntity' as const, entity: 0 } };
    } as never);

    const r = gw.dispatch({ kind: 'dupLeaf302' } as EditorOp);
    expect(r.ok).toBe(true);
    const last = gw.trace.last();
    expect(last).not.toBeNull();
    // engineCalls keeps every call (two spawns) — unchanged behavior (D-3).
    const spawnCalls = last!.attributes.engineCalls.filter((n) => n === 'world.spawn');
    expect(spawnCalls.length).toBe(2);
    // sideEffects dedups by engineInterface — exactly one world.spawn hint.
    const spawnHints = last!.attributes.sideEffects.filter((h) => h.engineInterface === 'world.spawn');
    expect(spawnHints.length).toBe(1);
    // Boundary: with dedup, sideEffects is strictly shorter than engineCalls here.
    expect(last!.attributes.sideEffects.length).toBeLessThan(last!.attributes.engineCalls.length);

    sessionAppliers.delete('dupLeaf302');
  });

  it('facade write outside any active span is a no-op (no throw, span stack stays empty)', () => {
    // No active span between dispatches. A raw facade write (e.g. per-frame
    // scaffolding) must not throw and must not fabricate a span — the _recordLeaf
    // `if (span)` guard also guards the sideEffects fill.
    expect(activeSpan()).toBeNull();
    const facade = new EngineFacade(new World());
    expect(() => facade.spawn()).not.toThrow();
    expect(activeSpan()).toBeNull();
  });

  it('every hint entry has a defined, non-empty hint string (missing entry would be skipped, never null)', () => {
    // Boundary: a missing table entry must be silently omitted (guarded fill),
    // never surface as an entry with an empty/undefined hint. So every present
    // entry is fully-formed.
    const gw = new EditGateway(createSession());
    spawnEntity(gw, 'boundary');
    const last = gw.trace.last();
    expect(last).not.toBeNull();
    for (const h of last!.attributes.sideEffects) {
      expect(typeof h.hint).toBe('string');
      expect(h.hint.length).toBeGreaterThan(0);
    }
  });
});
