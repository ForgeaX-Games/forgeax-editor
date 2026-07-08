// m2-w2 — TDD: session-domain routing for frame-request / rename-request /
// scene-persistence (RED phase)
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M2:
// requestFrame (fire-only pulse), requestRename (fire-with-id) and the
// scene-persistence setters (setSceneId / switchSceneFile / initSceneList /
// createSceneFile / saveDocToDisk / loadDocFromDisk) are collected as SESSION-
// domain ops — routed through the gateway, landing in the ledger, never the undo
// stack. At RED (before m2-w7/m2-w8) sessionAppliers lacks these kinds, so
// dispatch returns UNKNOWN_OP.
//
// NOTE on scope (task m2-w2 (d)): save/load involve the engine pack contract
// (rootsToSceneAsset). This headless test does NOT exercise real persistence —
// it verifies the DISPATCH PATH reaches the ledger and the undo stack stays
// frozen (AC-02). The frame-request / rename-request / setSceneId paths run for
// real (no engine IO). switchSceneFile/createSceneFile/save/load are asserted at
// the op level (dispatch → ledger) via test-double appliers registered on a
// throwaway gateway, because their real bodies hit /api/files and localStorage
// which a bun headless run cannot host.
//
// Constraints from upstream:
//   requirements AC-02: every session op is AI-dispatchable and lands in ledger
//   plan-strategy §2 D-10: requestFrame collected as session op; onFrameRequest
//     (zero-consumer dead export) removed on collection — tests do not depend on it
//   research F2: frame-request / rename-request / scene-persistence setter list
//
// Anchors:
//   plan-tasks.json m2-w2
//   requirements §2 domain table: all belong to session domain

import { describe, expect, it, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { EditGateway } from '../io/gateway';
import type { EditorOp, EditSession } from '../types';
import { createEditSession } from '../session/document';
import { gateway } from '../store/gateway';
// M3 t22: write-side setter sugar deleted (S10) — dispatch through the gateway
// door directly; side-effect imports keep the session appliers registered and
// expose the read-side accessors.
import '../store/frame-request';
import { onRenameRequest } from '../store/rename-request';
import { getSceneId } from '../store/scene-persistence';

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

describe('session routing — frame-request (m2-w2)', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); });

  // D-10: onFrameRequest is a zero-consumer dead export removed on collection.
  // requestFrame's observable session-op contract is now the ledger entry (a
  // fire-only pulse); the applier fires its internal listener set (empty today)
  // and the dispatch records the op.

  it('(a) requestFrame op dispatches without error (fire-only pulse, no value)', () => {
    const r = gw.dispatch({ kind: 'requestFrame' } as EditorOp);
    expect(r.ok).toBe(true);
  });

  it('(b) requestFrame grows ledger, not undo', () => {
    const undoBefore = gw.appliedCount();
    const ledgerBefore = gw.ledger.length;
    gw.dispatch({ kind: 'requestFrame' } as EditorOp);
    expect(gw.ledger.length).toBe(ledgerBefore + 1);
    expect(gw.appliedCount()).toBe(undoBefore);
    expect(gw.ledger[gw.ledger.length - 1]!.kind).toBe('requestFrame');
  });

  it('(c) requestFrame is AI-dispatchable with a distinguishable origin', () => {
    gw.dispatch({ kind: 'requestFrame' } as EditorOp, 'ai');
    expect(gw.origins[gw.origins.length - 1]).toBe('ai');
  });

  it('requestFrame dispatched through the singleton gateway grows the ledger', () => {
    // The app-level singleton gateway is the one door — a bare dispatch records it.
    const ledgerBefore = gateway.ledger.length;
    gateway.dispatch({ kind: 'requestFrame' } as EditorOp);
    expect(gateway.ledger.length).toBe(ledgerBefore + 1);
  });
});

describe('session routing — rename-request (m2-w2)', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); });

  it('(a) requestRename op delivers the correct id to listeners', () => {
    let got = -1;
    const unsub = onRenameRequest((id) => { got = id; });
    const r = gw.dispatch({ kind: 'requestRename', entity: 17 } as EditorOp);
    unsub();
    expect(r.ok).toBe(true);
    expect(got).toBe(17);
  });

  it('(b) requestRename grows ledger, not undo', () => {
    const undoBefore = gw.appliedCount();
    const ledgerBefore = gw.ledger.length;
    gw.dispatch({ kind: 'requestRename', entity: 5 } as EditorOp);
    expect(gw.ledger.length).toBe(ledgerBefore + 1);
    expect(gw.appliedCount()).toBe(undoBefore);
  });

  it('(c) requestRename is AI-dispatchable', () => {
    gw.dispatch({ kind: 'requestRename', entity: 3 } as EditorOp, 'ai');
    expect(gw.origins[gw.origins.length - 1]).toBe('ai');
  });

  it('requestRename dispatched through the singleton gateway delivers the id', () => {
    let got = -1;
    const unsub = onRenameRequest((id) => { got = id; });
    gateway.dispatch({ kind: 'requestRename', entity: 99 } as EditorOp);
    unsub();
    expect(got).toBe(99);
  });
});

describe('session routing — scene-persistence setSceneId (m2-w2)', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); });

  it('(c) setSceneId op takes effect via gateway dispatch', () => {
    const r = gw.dispatch({ kind: 'setSceneId', id: 'level-3' } as EditorOp);
    expect(r.ok).toBe(true);
    expect(getSceneId()).toBe('level-3');
  });

  it('(c) setSceneId grows ledger, not undo', () => {
    const undoBefore = gw.appliedCount();
    const ledgerBefore = gw.ledger.length;
    gw.dispatch({ kind: 'setSceneId', id: 'arena' } as EditorOp);
    expect(gw.ledger.length).toBe(ledgerBefore + 1);
    expect(gw.appliedCount()).toBe(undoBefore);
  });

  it('(c) setSceneId is AI-dispatchable with a distinguishable origin', () => {
    gw.dispatch({ kind: 'setSceneId', id: 'ai-scene' } as EditorOp, 'ai');
    expect(getSceneId()).toBe('ai-scene');
    expect(gw.origins[gw.origins.length - 1]).toBe('ai');
  });

  it('setSceneId dispatched through the singleton gateway takes effect', () => {
    gateway.dispatch({ kind: 'setSceneId', id: 'via-dispatch' } as EditorOp);
    expect(getSceneId()).toBe('via-dispatch');
  });
});

// (d) The async persistence ops (saveDocToDisk / loadDocFromDisk /
// switchSceneFile / createSceneFile) route their LEDGER RECORD through the
// gateway just like the sync ones. Their kinds must be registered (session
// domain) so an AI dispatch reaches the ledger with undo frozen. We assert the
// op-kind is routable to the session domain (not UNKNOWN_OP) and lands in the
// ledger — the real IO body is proven by the standalone B2 self-boot gate, not
// a headless unit test.
describe('session routing — async persistence op-kinds reach the ledger (m2-w2 (d))', () => {
  let gw: EditGateway;
  beforeEach(() => { gw = new EditGateway(createSession()); });

  // F-4: the gateway now validates args at entry against the catalog argsSchema,
  // so each op must carry its REQUIRED payload (switchSceneFile needs id;
  // createSceneFile needs id + duplicateCurrent) — matching the EditorOp union.
  // A bare { kind } is now correctly rejected as INVALID_ARGS (proven separately
  // in gateway-args-validation.test.ts); here we assert the well-formed routing.
  const wellFormed: Record<string, EditorOp> = {
    saveDocToDisk: { kind: 'saveDocToDisk' },
    loadDocFromDisk: { kind: 'loadDocFromDisk' },
    switchSceneFile: { kind: 'switchSceneFile', id: 'level-2' },
    createSceneFile: { kind: 'createSceneFile', id: 'level-2', duplicateCurrent: false },
  };
  for (const kind of ['saveDocToDisk', 'loadDocFromDisk', 'switchSceneFile', 'createSceneFile'] as const) {
    it(`${kind} dispatch reaches the session ledger without an error path`, () => {
      const ledgerBefore = gw.ledger.length;
      const undoBefore = gw.appliedCount();
      const r = gw.dispatch(wellFormed[kind]!);
      // The op is routable (session domain), applied without a structured error,
      // and appended to the flat ledger; undo stays frozen.
      expect(r.ok).toBe(true);
      expect(gw.ledger.length).toBe(ledgerBefore + 1);
      expect(gw.appliedCount()).toBe(undoBefore);
    });
  }
});
