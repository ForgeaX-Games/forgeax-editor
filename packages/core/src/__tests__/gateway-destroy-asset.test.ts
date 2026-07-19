// M2 / M4 — destroyAsset (document) + setDisplay (session) op contract.
//
// Verifies the gateway-level invariants for the two new ops introduced by the
// keyboard-router convergence:
//   - destroyAsset / restoreAsset are DOCUMENT-domain (inverse → undo + ledger)
//     and the applier goes through ctx.assetIO (the asset write gate, G-5).
//   - setDisplay is SESSION-domain: registered by edit-runtime at boot
//     (D-11), so a headless core gateway returns UNKNOWN_OP for it — same shape
//     as play/stop.
//
// The pack IO runs over the network (/api/files); we stub global fetch so the
// async delete/restore is deterministic without a server.

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import { listOps, hasOp, getOp } from '../io/catalog';
import { domainOf } from '../io/appliers';
import type { EditSession } from '../types';

const PACK = 'assets/x.pack.json';
const sampleAsset = { guid: 'g1', kind: 'mesh', name: 'M', payload: {}, refs: [] };

function makePack(assets: unknown[]): string {
  return JSON.stringify({ schemaVersion: '1.0', kind: 'internal-text-package', assets });
}

const originalFetch = globalThis.fetch;

describe('destroyAsset / restoreAsset op contract (M2)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    // Stub fetch: GET returns a pack containing sampleAsset; POST/DELETE (write) ok.
    (globalThis as unknown as { fetch: typeof fetch }).fetch = ((_url: string, opts?: { method?: string }) => {
      if (opts && (opts.method === 'POST' || opts.method === 'DELETE')) {
        return Promise.resolve(new Response('', { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ content: makePack([sampleAsset]) }), { status: 200 }));
    }) as unknown as typeof fetch;
    const session: EditSession = createEditSession();
    session.world = {} as never;
    gw = new EditGateway(session);
  });

  afterEach(() => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  });

  it('destroyAsset + restoreAsset are registered + correctly classed', () => {
    expect(hasOp('destroyAsset')).toBe(true);
    expect(hasOp('restoreAsset')).toBe(true);
    expect(domainOf('destroyAsset')).toBe('document');
    expect(domainOf('restoreAsset')).toBe('document');
  });

  it('destroyAsset dispatches ok, enters undo + ledger, returns restoreAsset inverse', () => {
    const ledgerBefore = gw.ledger.length;
    const undoBefore = gw.appliedCount();
    const r = gw.dispatch({ kind: 'destroyAsset', packPath: PACK, guid: 'g1' });
    expect(r.ok).toBe(true);
    // The document applier returns { ok: true } with NO inverse field — the inverse
    // is pushed onto the undo stack (the gateway is the single door; dispatch's
    // return type carries only ok/error). Assert the inverse shape via peekUndoInverse.
    const inverse = gw.peekUndoInverse();
    expect(inverse).toBeDefined();
    expect(inverse).toMatchObject({ kind: 'restoreAsset', packPath: PACK, guid: 'g1' });
    expect(gw.ledger.length).toBe(ledgerBefore + 1);
    expect(gw.appliedCount()).toBe(undoBefore + 1);
  });

  it('listOps exposes destroyAsset as a document op (AI-discoverable)', () => {
    const ops = listOps();
    const da = ops.find((o) => o.id === 'destroyAsset');
    expect(da).toBeDefined();
    expect(da?.domain).toBe('document');
  });
});

describe('setDisplay op contract (M4 T4-6)', () => {
  // setDisplay is registered by edit-runtime at boot (D-11) — so a headless core
  // gateway returns UNKNOWN_OP for it (same shape as play/stop), and domainOf()
  // (which reflects runtime applier registration) returns null. The SOT domain
  // classification therefore comes from the catalog, not domainOf.
  it('setDisplay is a SESSION op (catalog classification)', () => {
    expect(hasOp('setDisplay')).toBe(true);
    expect(getOp('setDisplay')?.domain).toBe('session');
    const ops = listOps();
    expect(ops.find((o) => o.id === 'setDisplay')?.domain).toBe('session');
  });

  it('headless core returns UNKNOWN_OP for setDisplay (boot-registered in edit-runtime, D-11)', () => {
    const session: EditSession = createEditSession();
    session.world = {} as never;
    const gw = new EditGateway(session);
    expect(domainOf('setDisplay')).toBeNull();
    const r = gw.dispatch({ kind: 'setDisplay', display: 'game' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNKNOWN_OP');
  });
});
