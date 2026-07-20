// gateway-play-write-gate.test.ts (w7) — play-mode document-domain write gate.
//
// feat-20260707-editor-world-fork-ssot-level-load-play-activeworld M2.
//
// plan-strategy D-5: while gateway.mode === 'play', a document-domain dispatch
// (any op that WRITES the world — spawnEntity / setComponent / rename / reparent
// / despawn / addComponent / removeComponent / transaction) must SHORT-CIRCUIT
// with a structured error { code: 'edit-rejected-in-play', hint }. Any applied
// document op would mutate editWorld and break the AC-07 freeze snapshot; and in
// the double-world model it would create an "edited in play, gone on stop" Edit!=Play
// illusion (requirements section 7). session-domain ops (play/stop/selection/camera)
// still pass — those are how the user LEAVES play. transientMode is left with its
// original semantics (D-5 explicitly does NOT reuse it — it still writes the world).
//
// Anchors:
//   plan-strategy D-5 (document-domain dispatch rejected in play, session passes)
//   requirements section 7 (play edits must not write playWorld -> Edit!=Play)
//   requirements AC-07 (editWorld freeze — any apply breaks the snapshot)
//   research Finding 13 (AI reaches gateway via dispatch; UI-disable is not a gate)

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import type { EditSession } from '../types';

// Side-effect import: registers the document/session appliers + selection applier.
import '../store/selection';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGateway = EditGateway & Record<string, any>;

function createSession(): EditSession {
  const s = createEditSession();
  s.world = new World();
  return s;
}

describe('w7 — play-mode document-domain write gate (D-5)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = new EditGateway(createSession());
  });

  // Spawn one entity in EDIT mode so we have a target id for later ops.
  function spawnInEdit(name: string): number {
    const r = gw.dispatch({ kind: 'spawnEntity', name, components: {} });
    expect(r.ok).toBe(true);
    return (gw.ledger.at(-1) as { _id: number })._id;
  }

  it('(a) spawnEntity is rejected in play with edit-rejected-in-play', () => {
    const g = gw as AnyGateway;
    g.enterPlay(new World());
    const r = gw.dispatch({ kind: 'spawnEntity', name: 'X', components: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('edit-rejected-in-play');
    expect(typeof r.error.hint).toBe('string');
    expect(r.error.hint.length).toBeGreaterThan(0);
  });

  it('(b) a document op in play does NOT mutate the world (no apply)', () => {
    const id = spawnInEdit('Keeper');
    const before = gw.ledger.length;
    const g = gw as AnyGateway;
    g.enterPlay(new World());
    // Attempt to rename in play — must be rejected AND not applied.
    const r = gw.dispatch({ kind: 'rename', entity: id, name: 'Renamed' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('edit-rejected-in-play');
    // ledger did not grow — no apply happened.
    expect(gw.ledger.length).toBe(before);
  });

  it('(c) multiple document-domain op kinds are all rejected in play', () => {
    const id = spawnInEdit('Multi');
    const g = gw as AnyGateway;
    g.enterPlay(new World());
    const docOps = [
      { kind: 'spawnEntity', name: 'Y', components: {} },
      { kind: 'destroyEntity', entity: id },
      { kind: 'rename', entity: id, name: 'Z' },
      { kind: 'setComponent', entity: id, component: 'Transform', patch: { pos: [1, 0, 0] } },
    ] as const;
    for (const op of docOps) {
      const r = gw.dispatch(op as never);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('edit-rejected-in-play');
    }
  });

  it('(d) session-domain ops (setSelection) still pass in play', () => {
    const id = spawnInEdit('Sel');
    const g = gw as AnyGateway;
    g.enterPlay(new World());
    // setSelection is a session op — it is how the user interacts during play, so
    // the write gate (document-domain only) must NOT block it. (setSceneId / play /
    // stop are also session ops but their appliers are boot-registered by
    // edit-runtime, so they are legitimately absent in headless core — the gate is
    // domain-scoped, proven here with the one session applier core registers.)
    const sel = gw.dispatch({ kind: 'setSelection', id });
    expect(sel.ok).toBe(true);
  });

  it('(e) after exitPlay, document ops are accepted again', () => {
    const id = spawnInEdit('Back');
    const g = gw as AnyGateway;
    g.enterPlay(new World());
    expect(gw.dispatch({ kind: 'rename', entity: id, name: 'Nope' }).ok).toBe(false);
    g.exitPlay();
    const r = gw.dispatch({ kind: 'rename', entity: id, name: 'Yes' });
    expect(r.ok).toBe(true);
  });

  it('(f) the gate is on mode (play), not transientMode — transientMode stays independent', () => {
    const id = spawnInEdit('Trans');
    // transientMode alone (edit mode) still applies + writes (D-5: not reused).
    gw.transientMode = true;
    const r = gw.dispatch({ kind: 'rename', entity: id, name: 'TransientApplied' });
    expect(r.ok).toBe(true); // transientMode does NOT reject; it writes but skips undo/ledger
    gw.transientMode = false;
  });
});
