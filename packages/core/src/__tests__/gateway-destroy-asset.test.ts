// M2 / M4 — destroyAsset (document) + setDisplay (session) op contract.
//
// Verifies the gateway-level invariants for the two new ops introduced by the
// keyboard-router convergence:
//   - destroyAsset is the public DOCUMENT-domain operation; restoreAsset is an
//     internal inverse, not a discoverable second entry.
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
import { setPathResolver } from '../util/path-resolver';
import { bindViewportRuntimeClient } from '../io/viewport-runtime-client';
import {
  VIEWPORT_RUNTIME_CONTRACT_VERSION,
  type MessagePortTransportClient,
  type ViewportRuntimeIdentity,
} from '@forgeax/editor-product';
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
    session.registry = {
      listCatalog: () => [{
        guid: 'g1', kind: 'mesh', packageUrl: PACK, sourcePath: PACK,
      }],
    } as never;
    gw = new EditGateway(session);
  });

  afterEach(() => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  });

  it('publishes destroyAsset while keeping its restore inverse internal', () => {
    expect(hasOp('destroyAsset')).toBe(true);
    expect(hasOp('restoreAsset')).toBe(false);
    expect(domainOf('destroyAsset')).toBe('document');
    expect(domainOf('restoreAsset')).toBe('document');
  });

  it('destroyAsset dispatches ok, enters undo + ledger, returns restoreAsset inverse', () => {
    const ledgerBefore = gw.ledger.length;
    const undoBefore = gw.appliedCount();
    const r = gw.dispatch({ kind: 'destroyAsset', guid: 'g1' });
    expect(r.ok).toBe(true);
    // The document applier returns { ok: true } with NO inverse field — the inverse
    // is pushed onto the undo stack (the gateway is the single door; dispatch's
    // return type carries only ok/error). Assert the inverse shape via peekUndoInverse.
    const inverse = gw.peekUndoInverse();
    expect(inverse).toBeDefined();
    expect(inverse).toMatchObject({ kind: 'restoreAsset', _resolvedPackPath: PACK, guid: 'g1' });
    expect(gw.ledger.length).toBe(ledgerBefore + 1);
    expect(gw.appliedCount()).toBe(undoBefore + 1);
  });

  it('listOps exposes destroyAsset as a document op (AI-discoverable)', () => {
    const ops = listOps();
    const da = ops.find((o) => o.id === 'destroyAsset');
    expect(da).toBeDefined();
    expect(da?.domain).toBe('document');
    expect(da?.argsSchema?.required).toEqual(['guid']);
    expect(da?.completion).toEqual({ kind: 'asset-write', guidField: 'guid' });
  });
});

// Regression (Studio ContentBrowser delete → GET /api/files 400): the producer
// catalog reports sourcePath in the play-runtime serve-mount space
// (host-games/<slug>/...), which the server safe-path whitelist rejects. The
// gateway must project the row through the runtime-bound catalog roots and the
// host-installed path resolver, so _resolvedPackPath lands on the on-disk
// layout (.forgeax/games/<slug>/...).
describe('destroyAsset storage-path projection (catalog serve-mount → host disk)', () => {
  const SLUG = 'testgame0812';
  const META_SOURCE = `host-games/${SLUG}/assets/bed.glb`;
  const RESOLVED_META = `.forgeax/games/${SLUG}/assets/bed.glb.meta.json`;
  const identity: ViewportRuntimeIdentity = {
    version: VIEWPORT_RUNTIME_CONTRACT_VERSION,
    runtimeId: 'edit-runtime',
    runtimeGeneration: 1,
    carrierId: 'frame-1',
    carrierKind: 'iframe',
  };
  const noopClient: MessagePortTransportClient = {
    request: () => Promise.reject(new Error('unused')),
    dispose() {},
  };

  let unbind: (() => void) | null = null;
  let requestedPaths: string[];
  let gw: EditGateway;

  beforeEach(() => {
    requestedPaths = [];
    (globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string, opts?: { method?: string }) => {
      const path = new URL(url, 'http://test.local').searchParams.get('path');
      if (path) requestedPaths.push(path);
      if (opts && (opts.method === 'POST' || opts.method === 'DELETE')) {
        return Promise.resolve(new Response('', { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        content: JSON.stringify({
          importer: 'gltf',
          source: 'bed.glb',
          subAssets: [{ guid: 'g1', kind: 'material', sourceIndex: 2, sourceKey: 'material:wood' }],
        }),
      }), { status: 200 }));
    }) as unknown as typeof fetch;
    setPathResolver((rel) => (rel ? `.forgeax/games/${SLUG}/${rel}` : `.forgeax/games/${SLUG}`));
    unbind = bindViewportRuntimeClient(identity, noopClient, [
      { root: 'assets', catalogPrefix: `host-games/${SLUG}/assets` },
    ]);
    const session: EditSession = createEditSession();
    session.world = {} as never;
    session.registry = {
      listCatalog: () => [{
        guid: 'g1', kind: 'material', packageUrl: '/__forgeax-ddc/mesh.pack.json', sourcePath: META_SOURCE,
      }],
    } as never;
    gw = new EditGateway(session);
  });

  afterEach(() => {
    unbind?.();
    unbind = null;
    setPathResolver(null);
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  });

  it('resolves the sidecar through catalog roots + host resolver, not the serve mount', () => {
    const r = gw.dispatch({ kind: 'destroyAsset', guid: 'g1' });
    expect(r.ok).toBe(true);
    const inverse = gw.peekUndoInverse();
    expect(inverse).toMatchObject({ kind: 'restoreAsset', _resolvedPackPath: RESOLVED_META, guid: 'g1' });
  });

  it('the async delete IO reads the resolved on-disk meta path', async () => {
    const r = gw.dispatch({ kind: 'destroyAsset', guid: 'g1' });
    expect(r.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestedPaths.length).toBeGreaterThan(0);
    expect(requestedPaths.every((p) => !p.startsWith('host-games/'))).toBe(true);
    expect(requestedPaths[0]).toBe(RESOLVED_META);
  });

  it('keeps the catalog-space fallback when no catalog roots are bound', () => {
    unbind?.();
    unbind = null;
    const r = gw.dispatch({ kind: 'destroyAsset', guid: 'g1' });
    expect(r.ok).toBe(true);
    expect(gw.peekUndoInverse()).toMatchObject({
      kind: 'restoreAsset',
      _resolvedPackPath: `${META_SOURCE}.meta.json`,
    });
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
