// authored-material-instance-persistence.test.ts — the two MI acceptance
// blockers, pinned end to end over the real chain.
//
// Bug 1 "created but no file / nowhere in the Content Browser":
//   the applier used to fire-and-forget the pack write and broadcast
//   assetsChanged immediately, so the CB refreshed against a pack-index that
//   predated the write. It now goes through scheduleAuthoredAssetWrite, the
//   same write → catalog-barrier → broadcast contract as createMaterial.
//
// Bug 2 "MI editor opens but nothing renders":
//   `material-instance` is an editor kind the engine's default loader table
//   does not carry, and Pack v2 loadByGuid HARD-FAILS on an unregistered kind.
//   So the barrier's LOAD phase could never succeed (bug 1 resurfacing as a
//   5 s stall + catalog error) and registry.assetCatalog could never hold an
//   MI envelope — resolveOverrides saw no parent chain and the preview stayed
//   on an unshaded baseline. registerMaterialInstanceLoader closes both.
//
// Chain driven: EditGateway.dispatch(createMaterialInstance) → applier →
// assetIO.createAssetInPack → createAuthoredAssetCatalogBarrier (the SAME
// barrier ViewportComponent installs) → awaitAuthoredMaterialReady.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { ShaderRegistry, type ShaderRegistryDevice } from '@forgeax/engine-shader';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import type { EditSession } from '../types';
// Barrel side-effect: registers the document/session appliers.
import '../index';
import {
  awaitAuthoredMaterialReady,
  registerPostAssetWriteCatalogSync,
} from '../session/authored-asset-write';
import { createAuthoredAssetCatalogBarrier } from '../assets/authored-asset-barrier';
import { registerMaterialInstanceLoader } from '../assets/material-instance-loader';
import { materialCatalogLookup } from '../assets/material-chain-catalog';
import { resolveOverrides } from '../assets/material-instance-resolve';
import { MATERIAL_INSTANCE_KIND } from '../assets/material-instance-schema';
import { setPathResolver } from '../util/path-resolver';

function makeShaderRegistry(): ShaderRegistry {
  const device: ShaderRegistryDevice = {
    createShaderModule() {
      return {
        ok: true,
        value: undefined,
        unwrap: () => undefined,
        unwrapOr: (fallback: unknown) => fallback,
      } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
    },
  };
  return new ShaderRegistry({ device, manifestUrl: undefined });
}

const PACK_PATH = 'sample/assets/materials.pack.json';
const PACK_BODY_URL = '/packs/materials.pack.json';
const PACK_INDEX_URL = '/pack-index.json';

interface FetchStub {
  fs: Map<string, string>;
  importCalls: string[];
  install(): void;
  restore(): void;
}

function makeFetchStub(): FetchStub {
  const fs = new Map<string, string>();
  const importCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  return {
    fs,
    importCalls,
    install() {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST' && url === '/api/files') {
          const body = JSON.parse(String(init.body)) as { path: string; content: string };
          fs.set(body.path, body.content);
          return new Response('{}', { status: 200 });
        }
        if (url.startsWith('/api/files?')) {
          const path = new URL(url, 'http://test.local').searchParams.get('path') ?? '';
          const content = fs.get(path);
          if (content === undefined) return new Response(null, { status: 404 });
          return new Response(JSON.stringify({ content }), { status: 200 });
        }
        if (url === PACK_INDEX_URL) {
          const rows: unknown[] = [];
          for (const [path, content] of fs) {
            if (!path.endsWith('.pack.json')) continue;
            const pack = JSON.parse(content) as { assets: { guid: string; kind: string; name?: string }[] };
            for (const asset of pack.assets) {
              rows.push({
                guid: asset.guid,
                kind: asset.kind,
                packageUrl: PACK_BODY_URL,
                ...(asset.name !== undefined ? { name: asset.name } : {}),
              });
            }
          }
          return new Response(JSON.stringify(rows), { status: 200 });
        }
        if (url === PACK_BODY_URL) {
          const content = fs.get(PACK_PATH);
          if (content === undefined) return new Response(null, { status: 404 });
          return new Response(content, { status: 200 });
        }
        if (url.startsWith('/__import/')) {
          importCalls.push(url);
          return new Response(JSON.stringify({ error: 'not an external import source' }), { status: 404 });
        }
        return new Response(null, { status: 404 });
      }) as typeof fetch;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

interface Harness {
  registry: AssetRegistry;
  gateway: EditGateway;
}

function makeHarness(net: FetchStub, opts?: { readonly withMiLoader?: boolean }): Harness {
  const registry = new AssetRegistry(makeShaderRegistry());
  registry.configurePackIndex(PACK_INDEX_URL);
  if (opts?.withMiLoader !== false) registerMaterialInstanceLoader(registry);
  const session: EditSession = createEditSession();
  session.world = new World() as unknown as EditSession['world'];
  session.registry = registry;
  registerPostAssetWriteCatalogSync(
    createAuthoredAssetCatalogBarrier(registry, { deadlineMs: 4000, rowPollMs: 5, bodyPollMs: 5 }),
  );
  void net;
  return { registry, gateway: new EditGateway(session) };
}

/** Author the parent material through the real createMaterial path so the MI's
 *  parent edge resolves out of the same pack a user would have. */
async function createParentMaterial(gateway: EditGateway): Promise<string> {
  const guid = crypto.randomUUID();
  const r = gateway.dispatch({
    kind: 'createMaterial',
    guid,
    name: 'M_Parent',
    baseColor: [0.25, 0.5, 0.75, 1],
    metallic: 0.4,
    roughness: 0.6,
    packPath: PACK_PATH,
  } as never);
  expect(r.ok).toBe(true);
  expect(await awaitAuthoredMaterialReady(guid)).toEqual({ ok: true });
  return guid;
}

describe('authored Material Instance persistence (write → catalog → load)', () => {
  let net: FetchStub;
  beforeEach(() => {
    setPathResolver((relativePath) => relativePath);
    net = makeFetchStub();
    net.install();
  });
  afterEach(() => {
    net.restore();
    registerPostAssetWriteCatalogSync(null);
    setPathResolver(null);
  });

  it('lands in the pack, becomes catalog-visible, and loads without /__import', async () => {
    const { registry, gateway } = makeHarness(net);
    const parentGuid = await createParentMaterial(gateway);

    const miGuid = crypto.randomUUID();
    const r = gateway.dispatch({
      kind: 'createMaterialInstance',
      guid: miGuid,
      name: 'MI_Parent_Inst',
      parentGuid,
      packPath: PACK_PATH,
      overrides: { roughness: { enabled: true, value: 0.1 } },
    } as never);
    expect(r.ok).toBe(true);

    // Bug 1: "created" must mean write landed AND the catalog saw it.
    expect(await awaitAuthoredMaterialReady(miGuid)).toEqual({ ok: true });

    // (1) The MI is on "disk" in the Pack v2 envelope, with the parent on refs[].
    const stored = net.fs.get(PACK_PATH);
    expect(stored).toBeDefined();
    const pack = JSON.parse(stored as string) as {
      schemaVersion: string;
      assets: { guid: string; kind: string; name?: string; refs?: string[]; payload?: Record<string, unknown> }[];
    };
    expect(pack.schemaVersion).toBe('2.0.0');
    const entry = pack.assets.find((a) => a.guid === miGuid);
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe(MATERIAL_INSTANCE_KIND);
    expect(entry?.name).toBe('MI_Parent_Inst');
    expect(entry?.refs).toContain(parentGuid);
    expect(entry?.payload?.parent).toBe(parentGuid);

    // (2) The pack-index row the Content Browser reads is served.
    expect(registry.packIndexCache?.get(miGuid.toLowerCase())?.packageUrl).toBe(PACK_BODY_URL);

    // (3) loadByGuid resolves the MI from the pack body (the barrier's LOAD
    // phase already proved it; prove it is stable and repeatable).
    const parsed = AssetGuid.parse(miGuid);
    if (!parsed.ok) throw new Error('bad MI GUID');
    expect((await registry.loadByGuid(parsed.value)).ok).toBe(true);

    // (4) No external-import fallback for an internal asset.
    expect(net.importCalls).toEqual([]);
  });

  // Bug 2's mechanism, isolated: without the host loader the engine cannot
  // load the kind at all, so the barrier never clears and nothing downstream
  // (inspector fields, preview values) can read a chain.
  it('without the MI loader registered the catalog barrier never clears', async () => {
    const withLoader = makeHarness(net);
    const parentGuid = await createParentMaterial(withLoader.gateway);

    const registry = new AssetRegistry(makeShaderRegistry());
    registry.configurePackIndex(PACK_INDEX_URL);
    const session: EditSession = createEditSession();
    session.world = new World() as unknown as EditSession['world'];
    session.registry = registry;
    registerPostAssetWriteCatalogSync(
      createAuthoredAssetCatalogBarrier(registry, { deadlineMs: 150, rowPollMs: 5, bodyPollMs: 5 }),
    );
    const gateway = new EditGateway(session);

    const miGuid = crypto.randomUUID();
    expect(gateway.dispatch({
      kind: 'createMaterialInstance',
      guid: miGuid,
      name: 'MI_NoLoader',
      parentGuid,
      packPath: PACK_PATH,
    } as never).ok).toBe(true);

    const ready = await awaitAuthoredMaterialReady(miGuid);
    expect(ready.ok).toBe(false);
    if (!ready.ok) expect(ready.stage).toBe('catalog');

    // …and the same GUID clears once the loader is wired, proving the loader
    // (not the pack bytes) was the blocker.
    registerMaterialInstanceLoader(registry);
    const parsed = AssetGuid.parse(miGuid);
    if (!parsed.ok) throw new Error('bad MI GUID');
    expect((await registry.loadByGuid(parsed.value)).ok).toBe(true);
  });

  it('catalogs the parent chain so resolveOverrides yields inherited values', async () => {
    const { registry, gateway } = makeHarness(net);
    const parentGuid = await createParentMaterial(gateway);

    const miGuid = crypto.randomUUID();
    gateway.dispatch({
      kind: 'createMaterialInstance',
      guid: miGuid,
      name: 'MI_Resolve',
      parentGuid,
      packPath: PACK_PATH,
      overrides: { roughness: { enabled: true, value: 0.1 } },
    } as never);
    expect(await awaitAuthoredMaterialReady(miGuid)).toEqual({ ok: true });

    // The MI envelope is live, and its refs[] recursion pulled the parent in
    // with it — a synchronous resolve now sees the whole chain.
    const lookup = materialCatalogLookup(registry);
    expect(lookup(miGuid)?.kind).toBe(MATERIAL_INSTANCE_KIND);
    expect(lookup(parentGuid)?.kind).toBe('material');

    const resolved = resolveOverrides(miGuid, lookup);
    // Inherited from the parent material…
    expect(resolved.metallic).toBe(0.4);
    expect(resolved.baseColor).toEqual([0.25, 0.5, 0.75, 1]);
    // …and the MI's own enabled override wins over the parent's 0.6.
    expect(resolved.roughness).toBe(0.1);
  });
});
