// createMaterial (document) op registration + validation + payload contract.
//
// solo round-12 / P5 rendering-authoring: round-11's bindAssetRef let an AI BIND an
// existing catalogued material GUID onto a mesh, but NO op could AUTHOR a new PBR
// material from params — the deeper "author PBR materials" half of P5. createAsset
// (the closest sibling) mints only BLANK payloads per kind and is not even cataloged
// (invisible to listOps → an AI can't discover it). createMaterial fixes both: a
// cataloged, param-driven DOCUMENT op that builds the POD via the engine's canonical
// Materials.standard() builder and writes it through the asset gate. This test would
// have FAILED before the fix (no op → hasOp false, dispatch → UNKNOWN_OP) and pins:
//   - createMaterial is a cataloged DOCUMENT op (AI-discoverable via listOps),
//     with guid/name/baseColor required.
//   - a malformed op fails fast with a STRUCTURED INVALID_ARGS (never a silent no-op).
//   - the applier builds a real Materials.standard() POD carrying the authored
//     baseColor/metallic/roughness, written to the pack via ctx.assetIO — proven by
//     calling the applier with a capturing fake ctx (the real IO is a detached fetch).
//
// The full mint→catalog→bind→save round-trip needs a LIVE world/registry/server (the
// live-drive verify step in the round REPORT proves that end-to-end); this unit pins
// the front-door contract the friction was about.

import { describe, expect, it, beforeEach } from 'bun:test';
import { EditGateway } from '../io/gateway';
import { AssetIOFacade } from '../io/asset-io-facade';
import { createEditSession } from '../session/document';
import { hasOp, getOp, listOps } from '../io/catalog';
// Importing the barrel loads pack-ops' side-effect (document applier registration),
// exactly as the app boot does.
import '../index';
import type { EditSession } from '../types';

describe('createMaterial op registration (catalog SSOT)', () => {
  it('createMaterial is a cataloged DOCUMENT op (AI-discoverable)', () => {
    expect(hasOp('createMaterial')).toBe(true);
    expect(getOp('createMaterial')?.domain).toBe('document');
    const op = listOps().find((o) => o.id === 'createMaterial');
    expect(op?.domain).toBe('document');
    // argsSchema drives AI self-discovery — the three authoring inputs are required.
    for (const req of ['guid', 'name', 'baseColor']) {
      expect(op?.argsSchema?.required).toContain(req);
    }
  });

  it('argsSchema documents the caller-mints-guid contract + PBR params', () => {
    const op = listOps().find((o) => o.id === 'createMaterial');
    const props = op?.argsSchema?.properties ?? {};
    // guid description must tell the AI to mint it AND reuse it for bindAssetRef
    // (the op cannot return a minted guid — the round's core contract finding).
    expect(String(props.guid?.description ?? '')).toMatch(/bindAssetRef|reuse/i);
    // baseColor is the load-bearing PBR param.
    expect(props.baseColor?.type).toBe('array');
    expect(String(props.baseColor?.description ?? '')).toMatch(/sRGB|stored unchanged/);
  });
});

describe('createMaterial dispatch (document applier — validation)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    const session: EditSession = createEditSession();
    session.world = {} as never;
    gw = new EditGateway(session);
  });

  it('missing baseColor fails fast with a STRUCTURED error (not a silent no-op)', () => {
    const r = gw.dispatch({ kind: 'createMaterial', guid: 'g', name: 'Red' } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('missing guid fails fast with a STRUCTURED error', () => {
    const r = gw.dispatch({ kind: 'createMaterial', name: 'Red', baseColor: [1, 0, 0, 1] } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('a 3-element baseColor (not [r,g,b,a]) fails fast', () => {
    const r = gw.dispatch({ kind: 'createMaterial', guid: 'g', name: 'Red', baseColor: [1, 0, 0] } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('valid args are accepted (fire-and-forget; the pack write runs detached)', () => {
    // The applier returns synchronously {ok:true}; the async IO (a detached fetch to
    // the file server) no-ops in the unit env and is caught — the intended contract.
    // Pass an explicit packPath so the unit does not depend on a host path resolver
    // (an eval AI omits packPath and the applier defaults it via resolveGamePath).
    const r = gw.dispatch({
      kind: 'createMaterial',
      guid: '019f56f2-0ac0-776a-9d28-50eaf795daed',
      name: 'Matte Red Plastic',
      baseColor: [0.8, 0.1, 0.1, 1],
      metallic: 0,
      roughness: 0.9,
      packPath: 'games/sample/assets/scene.pack.json',
    });
    expect(r.ok).toBe(true);
  });

  it('an out-of-range alphaCutoff fails fast with a STRUCTURED error', () => {
    const r = gw.dispatch({
      kind: 'createMaterial',
      guid: 'g',
      name: 'Red',
      baseColor: [1, 0, 0, 1],
      alphaCutoff: 1.5,
      packPath: 'games/sample/assets/scene.pack.json',
    } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('no packPath + no resolver fails fast with a STRUCTURED error (not a throw)', () => {
    // In the unit env no host path resolver is installed; omitting packPath must
    // return INVALID_ARGS, never let resolveGamePath throw out of dispatch.
    const r = gw.dispatch({
      kind: 'createMaterial',
      guid: '019f56f2-0ac0-776a-9d28-50eaf795daed',
      name: 'Red',
      baseColor: [1, 0, 0, 1],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });
});

// Direct-applier payload contract: the fire-and-forget dispatch path swallows the IO,
// so to PROVE the authored params reach the pack we call the applier with a capturing
// fake DocApplierCtx (mirrors how the gateway builds ctx). This asserts the built POD
// is a real Materials.standard() material carrying the authored baseColor/metallic/
// roughness — the exact data-loss the friction was about (a material with no params).
describe('createMaterial applier builds a real Materials.standard() POD', () => {
  it('the pack entry carries kind:material + the authored PBR params', async () => {
    const { applyCreateMaterial } = await import('../session/pack-ops');
    interface CapturedCreate {
      packPath: string;
      asset: { guid: string; kind: string; name: string; payload: Record<string, unknown> };
    }
    let captured: CapturedCreate | null = null;
    const fakeCtx = {
      assetIO: {
        createAssetInPack(opts: CapturedCreate) {
          captured = opts;
          return Promise.resolve({ ok: true });
        },
      },
    } as never;
    const r = applyCreateMaterial(fakeCtx, {
      kind: 'createMaterial',
      guid: 'abc',
      name: 'Gold',
      baseColor: [1, 0.84, 0, 1],
      metallic: 1,
      roughness: 0.25,
      packPath: 'some/pack.pack.json',
    } as never);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // inverse is destroyAsset on the same guid/pack (undo for free).
      expect((r.inverse as { kind: string; guid: string }).kind).toBe('destroyAsset');
      expect((r.inverse as { kind: string; guid: string }).guid).toBe('abc');
    }
    expect(captured).not.toBeNull();
    const cap = captured as unknown as CapturedCreate;
    expect(cap.asset.kind).toBe('material');
    expect(cap.asset.guid).toBe('abc');
    const payload = cap.asset.payload as { kind: string; colorSpace?: string; passes: unknown[]; values: Record<string, unknown> };
    expect(payload.kind).toBe('material');
    // Materials.standard emits the multi-pass HDRP shape (>=2 passes incl. ShadowCaster).
    expect(Array.isArray(payload.passes)).toBe(true);
    expect(payload.passes.length).toBeGreaterThanOrEqual(2);
    // The authored params survive into values (the data-loss the friction feared).
    expect(payload.values.baseColor).toEqual([1, 0.84, 0, 1]);
    // Omission is the schema-defined sRGB default; existing numeric assets need no migration.
    expect(payload.colorSpace).toBeUndefined();
    expect(payload.values.metallic).toBe(1);
    expect(payload.values.roughness).toBe(0.25);
  });

  it('a valid alphaCutoff lands in the POD values (UE-Masked equivalent)', async () => {
    const { applyCreateMaterial } = await import('../session/pack-ops');
    interface CapturedCreate {
      packPath: string;
      asset: { guid: string; kind: string; name: string; payload: Record<string, unknown> };
    }
    let captured: CapturedCreate | null = null;
    const fakeCtx = {
      assetIO: {
        createAssetInPack(opts: CapturedCreate) {
          captured = opts;
          return Promise.resolve({ ok: true });
        },
      },
    } as never;
    const r = applyCreateMaterial(fakeCtx, {
      kind: 'createMaterial',
      guid: 'abc2',
      name: 'Leaf',
      baseColor: [1, 1, 1, 1],
      baseColorTexture: 'e5555555-5555-4555-8555-555555555555',
      alphaCutoff: 0.5,
      packPath: 'some/pack.pack.json',
    } as never);
    expect(r.ok).toBe(true);
    const cap = captured as unknown as CapturedCreate;
    const payload = cap.asset.payload as { values: Record<string, unknown> };
    expect(payload.values.alphaCutoff).toBe(0.5);
    // The texture GUID is stored as a refs[] index (engine disk format SSOT).
    expect(payload.values.baseColorTexture).toBe(0);
    expect((cap.asset as unknown as { refs: string[] }).refs).toContain('e5555555-5555-4555-8555-555555555555');
  });
});

// Phantom-texture Fail Fast (gray-quad root cause): a material authored with a
// baseColorTexture GUID that is not in the live catalog can NEVER resolve at
// render — it silently shades with the plain baseColor forever. The applier
// must reject it synchronously with INVALID_ARGS instead of writing an orphan
// pack entry. Validation is registry-mediated: a KNOWN miss rejects, an
// unavailable registry (direct-applier unit ctx with no engine facade) is
// tolerated so the IO/payload contract tests above keep their narrow focus.
describe('createMaterial baseColorTexture phantom-ref validation', () => {
  const baseOp = {
    kind: 'createMaterial',
    guid: 'mat-1',
    name: 'Wood',
    baseColor: [1, 1, 1, 1],
    packPath: 'some/pack.pack.json',
  } as const;

  it('rejects a non-GUID baseColorTexture (path / display name)', async () => {
    const { applyCreateMaterial } = await import('../session/pack-ops');
    const r = applyCreateMaterial({} as never, {
      ...baseOp,
      baseColorTexture: 'assets/wood.png',
    } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('INVALID_ARGS');
      expect(r.error.hint).toContain('RFC 4122');
    }
  });

  it('rejects a well-formed GUID that is a KNOWN catalog miss', async () => {
    const { applyCreateMaterial } = await import('../session/pack-ops');
    const fakeCtx = {
      engine: { isAssetCatalogued: () => false },
      assetIO: { createAssetInPack() { return Promise.resolve({ ok: true }); } },
    } as never;
    const r = applyCreateMaterial(fakeCtx, {
      ...baseOp,
      baseColorTexture: 'e5555555-5555-4555-8555-555555555555',
    } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('INVALID_ARGS');
      expect(r.error.hint).toContain('not in the live asset catalog');
    }
  });

  it('accepts a catalogued texture GUID (isAssetCatalogued true)', async () => {
    const { applyCreateMaterial } = await import('../session/pack-ops');
    let captured: { asset: { refs?: string[] } } | null = null;
    const fakeCtx = {
      engine: { isAssetCatalogued: () => true },
      assetIO: {
        createAssetInPack(opts: { asset: { refs?: string[] } }) {
          captured = opts;
          return Promise.resolve({ ok: true });
        },
      },
    } as never;
    const r = applyCreateMaterial(fakeCtx, {
      ...baseOp,
      baseColorTexture: 'e5555555-5555-4555-8555-555555555555',
    } as never);
    expect(r.ok).toBe(true);
    expect((captured as unknown as { asset: { refs: string[] } }).asset.refs)
      .toContain('e5555555-5555-4555-8555-555555555555');
  });

  it('tolerates an unavailable registry (isAssetCatalogued undefined / no engine)', async () => {
    const { applyCreateMaterial } = await import('../session/pack-ops');
    const withEngine = applyCreateMaterial({
      engine: { isAssetCatalogued: () => undefined },
      assetIO: { createAssetInPack() { return Promise.resolve({ ok: true }); } },
    } as never, {
      ...baseOp,
      guid: 'mat-2',
      baseColorTexture: 'e5555555-5555-4555-8555-555555555555',
    } as never);
    expect(withEngine.ok).toBe(true);
    const noEngine = applyCreateMaterial({
      assetIO: { createAssetInPack() { return Promise.resolve({ ok: true }); } },
    } as never, {
      ...baseOp,
      guid: 'mat-3',
      baseColorTexture: 'e5555555-5555-4555-8555-555555555555',
    } as never);
    expect(noEngine.ok).toBe(true);
  });
});

describe('AssetIOFacade authored pack version', () => {
  it('writes a new material pack in the runtime Pack v2 envelope', async () => {
    const originalFetch = globalThis.fetch;
    let posted: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/files?')) {
        return new Response(null, { status: 404 });
      }
      posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      const result = await new AssetIOFacade().createAssetInPack({
        packPath: 'sample/assets/new-materials.pack.json',
        asset: {
          guid: '019fc6d1-4a9f-74d2-af06-a41a3f0563ce',
          kind: 'material',
          name: 'New Material',
          payload: { kind: 'material', values: {} },
          refs: [],
        },
      });
      expect(result.ok).toBe(true);
      const writtenBody = posted as unknown as { content: string };
      expect(writtenBody.content).toContain('"schemaVersion": "2.0.0"');
      expect(writtenBody.content).toContain('"artifacts": {}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// Post-write catalog-sync seam: the applier must await the host-registered
// hook (pack-index row + envelope live) BEFORE broadcasting assetsChanged,
// otherwise a follow-up updateMaterialParams on the fresh GUID finds no
// envelope (the watcher rebuild races the broadcast).
describe('createMaterial post-write catalog-sync seam', () => {
  it('awaits the registered sync hook before broadcasting assetsChanged', async () => {
    const { applyCreateMaterial, registerPostAssetWriteCatalogSync } = await import('../session/pack-ops');
    const { panelBridge } = await import('../io/panel-bridge');

    const events: string[] = [];
    const dispose = panelBridge.on('assetsChanged', () => { events.push('broadcast'); });
    registerPostAssetWriteCatalogSync(async (guid) => { events.push(`sync:${guid}`); });
    try {
      let resolveIo!: (value: { ok: boolean }) => void;
      const fakeCtx = {
        assetIO: {
          createAssetInPack() {
            return new Promise<{ ok: boolean }>((resolve) => { resolveIo = resolve; });
          },
        },
      } as never;
      const r = applyCreateMaterial(fakeCtx, {
        kind: 'createMaterial',
        guid: 'guid-sync-1',
        name: 'Synced',
        baseColor: [1, 1, 1, 1],
        packPath: 'some/pack.pack.json',
      } as never);
      expect(r.ok).toBe(true);
      resolveIo({ ok: true });
      // Flush the applier's .then continuation + the awaited hook.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual(['sync:guid-sync-1', 'broadcast']);
    } finally {
      registerPostAssetWriteCatalogSync(null);
      dispose();
    }
  });

  it('broadcasts without a hook when none is registered (unit env / no host)', async () => {
    const { applyCreateMaterial, registerPostAssetWriteCatalogSync } = await import('../session/pack-ops');
    const { panelBridge } = await import('../io/panel-bridge');
    registerPostAssetWriteCatalogSync(null);

    const events: string[] = [];
    const dispose = panelBridge.on('assetsChanged', () => { events.push('broadcast'); });
    try {
      const fakeCtx = {
        assetIO: { createAssetInPack() { return Promise.resolve({ ok: true }); } },
      } as never;
      const r = applyCreateMaterial(fakeCtx, {
        kind: 'createMaterial',
        guid: 'guid-sync-2',
        name: 'NoHook',
        baseColor: [1, 1, 1, 1],
        packPath: 'some/pack.pack.json',
      } as never);
      expect(r.ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual(['broadcast']);
    } finally {
      dispose();
    }
  });
});
