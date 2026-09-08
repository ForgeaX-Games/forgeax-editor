// preview-world-service.test.ts — STD-01/T1.1 lifecycle and isolation guard.
//
// The engine boundary is injected rather than module-mocked. This keeps the
// test deterministic without leaking Bun module mocks into sibling test files.

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  PreviewWorldService,
  type PreviewWorldServiceDependencies,
} from '../preview-world-service';

type FakeHost = HTMLDivElement & { readonly children: readonly unknown[] };
type FakeApp = {
  readonly world: object;
  readonly renderer: {
  readonly assets: {
    configureRuntimeBinding(binding: unknown): void;
    invalidate(guid: unknown): void;
    loadByGuid(guid: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code: string } }>;
    instantiate(handle: unknown, world: unknown): { ok: boolean; value?: unknown; error?: { code: string } };
  };
  };
  readonly start: ReturnType<typeof mock>;
  readonly stop: ReturnType<typeof mock>;
  readonly debugDraw?: unknown;
};
type FakeViewport = {
  readonly resetCamera: ReturnType<typeof mock>;
  readonly frameBounds: ReturnType<typeof mock>;
  readonly refresh: ReturnType<typeof mock>;
  readonly drawOverlay: ReturnType<typeof mock>;
  readonly getOverlayVertexData: ReturnType<typeof mock>;
  readonly dispose: ReturnType<typeof mock>;
};
type FakeAssembly = {
  readonly bounds: {
    readonly center: readonly [number, number, number];
    readonly radius: number;
  };
  readonly replaced: unknown[];
  readonly hidden: boolean[];
  replaceSubject(mesh: unknown): FakeAssembly['bounds'];
  hideMeshSubject(): void;
};

const apps: FakeApp[] = [];
const viewports: FakeViewport[] = [];
const assemblies: FakeAssembly[] = [];
const boundsOverlayInstalls: { readonly debugDraw: unknown; readonly getAabb: () => unknown; readonly isVisible: () => boolean }[] = [];
const skeletonOverlayInstalls: { readonly debugDraw: unknown; readonly getRoot: () => unknown; readonly isVisible: () => boolean }[] = [];
let sceneInstantiateCalls = 0;
let lastSceneInstantiateHandle: unknown = undefined;
let sceneInstantiateOk = true;
const sceneRootHandle = 4242;
const sceneDespawnCalls: unknown[] = [];
const payloads = new Map<string, unknown | Promise<unknown>>();
const previewPayloads = new Map<string, unknown>();
let queryCalls = 0;
let previewLoadCalls = 0;
let previewInvalidateCalls = 0;
const configuredBindings: unknown[] = [];
const createdBundlerOptions: unknown[] = [];
const defaultRuntimeBinding = {
  schemaVersion: 'runtime-asset-binding-v1',
  gameId: 'game-test',
  scopeId: 'scope-test',
  generation: 1,
  status: 'ready',
  catalogUrl: '/__pack/scopes/scope-test/1/catalog.json',
  importUrlBase: '/__pack/scopes/scope-test/1/import',
  packageUrlBase: '/__pack/scopes/scope-test/1/asset',
} as const;

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

function installDom(): void {
  globalThis.document = {
    createElement: () => {
      const canvas = {
        className: '',
        style: {} as Record<string, string>,
        width: 0,
        height: 0,
        parentElement: null as FakeHost | null,
      };
      return canvas;
    },
  } as unknown as Document;
  globalThis.window = { devicePixelRatio: 1 } as unknown as Window & typeof globalThis;
}

function makeHost(): FakeHost {
  const children: unknown[] = [];
  const host = {
    children,
    appendChild(child: { parentElement: FakeHost | null }) {
      children.push(child);
      child.parentElement = host as unknown as FakeHost;
      return child;
    },
    removeChild(child: unknown) {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
      if (child && typeof child === 'object' && 'parentElement' in child) {
        (child as { parentElement: FakeHost | null }).parentElement = null;
      }
      return child;
    },
    getBoundingClientRect: () => ({ width: 320, height: 200 }),
  };
  return host as unknown as FakeHost;
}

function meshAsset(guid: string): {
  readonly kind: 'mesh';
  readonly guid: string;
  readonly name: string;
  readonly packPath: string;
  readonly payload: Record<string, unknown>;
} {
  return { kind: 'mesh', guid, name: guid, packPath: 'sample/assets/test.pack.json', payload: {} };
}

function sceneAsset(guid: string, skinGuids: readonly string[] = []): {
  readonly kind: 'scene';
  readonly guid: string;
  readonly name: string;
  readonly packPath: string;
  readonly payload: Record<string, unknown>;
} {
  return {
    kind: 'scene',
    guid,
    name: guid,
    packPath: 'sample/assets/test.pack.json',
    payload: { kind: 'scene', entities: [], skinGuids },
  };
}

function createDependencies(
  runtimeBinding: unknown | null = defaultRuntimeBinding,
  projectedBinding?: unknown,
): PreviewWorldServiceDependencies {
  return {
    createApp: (async (_canvas: unknown, _options: unknown, bundlerOptions: unknown) => {
      createdBundlerOptions.push(bundlerOptions);
      const app: FakeApp = {
        world: {},
        renderer: {
          assets: {
            invalidate() { previewInvalidateCalls += 1; },
            configureRuntimeBinding(binding) {
              configuredBindings.push(binding);
            },
            async loadByGuid(guid) {
              previewLoadCalls += 1;
              const key = guid instanceof Uint8Array
                ? [...guid].map((byte) => byte.toString(16).padStart(2, '0')).join('')
                : '';
              const value = previewPayloads.get(key);
              return value === undefined
                ? { ok: false, error: { code: 'asset-not-found' } }
                : { ok: true, value };
            },
            instantiate(handle, _world) {
              sceneInstantiateCalls += 1;
              lastSceneInstantiateHandle = handle;
              return sceneInstantiateOk
                ? { ok: true, value: sceneRootHandle }
                : { ok: false, error: { code: 'scene-instantiate-failed' } };
            },
          },
        },
        start: mock(() => undefined),
        stop: mock(() => undefined),
        debugDraw: undefined,
      };
      apps.push(app);
      return { ok: true as const, value: app };
    }) as unknown as PreviewWorldServiceDependencies['createApp'],
    createEngineFacade: (() => ({
      despawnScene(root: unknown) { sceneDespawnCalls.push(root); },
      allocSharedRef(_target: string, _payload: unknown) { return { facadeHandle: true }; },
    })) as unknown as PreviewWorldServiceDependencies['createEngineFacade'],
    getViewportRuntimeClientSnapshot: (() => ({ status: 'ready' })) as PreviewWorldServiceDependencies['getViewportRuntimeClientSnapshot'],
    queryViewportRuntimeProjection: (async (query: { readonly kind: string; readonly guid?: string }) => {
      queryCalls += 1;
      if (query.kind === 'assets.runtime-binding') {
        return projectedBinding === undefined
          ? { status: 'empty' as const }
          : { status: 'ready' as const, value: projectedBinding };
      }
      const guid = query.guid ?? '';
      const payload = payloads.get(guid);
      if (payload === undefined) return { status: 'empty' as const };
      return {
        status: 'ready' as const,
        value: { guid, payload: await payload },
      };
    }) as PreviewWorldServiceDependencies['queryViewportRuntimeProjection'],
    assembleMeshPreviewWorld: (() => {
      const assembly: FakeAssembly = {
        bounds: { center: [0, 0, 0], radius: 1 },
        replaced: [],
        hidden: [],
        replaceSubject(mesh) {
          this.replaced.push(mesh);
          this.hidden.push(false);
          return this.bounds;
        },
        hideMeshSubject() {
          this.hidden.push(true);
        },
      };
      assemblies.push(assembly);
      return assembly;
    }) as unknown as PreviewWorldServiceDependencies['assembleMeshPreviewWorld'],
    createViewport: (() => {
      const viewport: FakeViewport = {
        resetCamera: mock(() => undefined),
        frameBounds: mock(() => undefined),
        refresh: mock(() => undefined),
        drawOverlay: mock(() => undefined),
        getOverlayVertexData: mock(() => new Float32Array(0)),
        dispose: mock(() => undefined),
      };
      viewports.push(viewport);
      return viewport;
    }) as PreviewWorldServiceDependencies['createViewport'],
    getRuntimeBinding: (() => runtimeBinding ?? undefined) as PreviewWorldServiceDependencies['getRuntimeBinding'],
    installBoundsOverlay: ((deps) => {
      boundsOverlayInstalls.push({
        debugDraw: deps.debugDraw,
        getAabb: deps.getAabb,
        isVisible: deps.isVisible,
      });
    }) as PreviewWorldServiceDependencies['installBoundsOverlay'],
    installSkeletonOverlay: ((deps) => {
      skeletonOverlayInstalls.push({
        debugDraw: deps.debugDraw,
        getRoot: deps.getRoot,
        isVisible: deps.isVisible,
      });
    }) as PreviewWorldServiceDependencies['installSkeletonOverlay'],
  };
}

beforeEach(() => {
  apps.length = 0;
  viewports.length = 0;
  assemblies.length = 0;
  payloads.clear();
  previewPayloads.clear();
  queryCalls = 0;
  previewLoadCalls = 0;
  previewInvalidateCalls = 0;
  configuredBindings.length = 0;
  createdBundlerOptions.length = 0;
  boundsOverlayInstalls.length = 0;
  skeletonOverlayInstalls.length = 0;
  sceneInstantiateCalls = 0;
  sceneDespawnCalls.length = 0;
  lastSceneInstantiateHandle = undefined;
  sceneInstantiateOk = true;
  installDom();
});

describe('PreviewWorldService', () => {
  it('mounts one independent app and makes mount/dispose idempotent', async () => {
    const service = new PreviewWorldService(createDependencies());
    const host = makeHost();
    const first = service.mount(host, () => undefined);
    const second = service.mount(host, () => undefined);

    expect(second).toBe(first);
    await first;
    expect(service.isAlive).toBe(true);
    expect(apps).toHaveLength(1);
    expect(viewports).toHaveLength(1);
    expect(host.children).toHaveLength(1);

    service.dispose();
    service.dispose();
    expect(service.isAlive).toBe(false);
    expect(apps[0]?.stop).toHaveBeenCalledTimes(1);
    expect(viewports[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(host.children).toHaveLength(0);

    const remountHost = makeHost();
    await service.mount(remountHost, () => undefined);
    expect(apps).toHaveLength(1);
    expect(remountHost.children).toHaveLength(0);
  });

  it('installs the Bounds overlay once on boot, wired to the live assembly AABB and visibility toggle', async () => {
    const service = new PreviewWorldService(createDependencies());
    await service.mount(makeHost(), () => undefined);

    expect(boundsOverlayInstalls).toHaveLength(1);
    const install = boundsOverlayInstalls[0]!;
    // No DebugDraw in the headless fake app; the overlay must tolerate that.
    expect(install.debugDraw).toBeUndefined();
    expect(install.isVisible()).toBe(true);
    // No subject loaded yet → getter reports null.
    expect(install.getAabb()).toBeNull();

    service.setBoundsOverlayVisible(false);
    expect(install.isVisible()).toBe(false);
  });

  it('installs the Skeleton overlay once on boot, wired to the live scene root and visibility toggle', async () => {
    const service = new PreviewWorldService(createDependencies());
    await service.mount(makeHost(), () => undefined);

    expect(skeletonOverlayInstalls).toHaveLength(1);
    const install = skeletonOverlayInstalls[0]!;
    expect(install.debugDraw).toBeUndefined();
    expect(install.isVisible()).toBe(true);
    // No scene subject loaded yet → root getter reports null.
    expect(install.getRoot()).toBeNull();

    service.setSkeletonOverlayVisible(false);
    expect(install.isVisible()).toBe(false);
  });

  it('replaces subjects in the preview world and never queries after disposal', async () => {
    const payload = { kind: 'mesh', vertices: new Float32Array([0, 0, 0]), submeshes: [] };
    payloads.set('mesh-a', payload);
    const service = new PreviewWorldService(createDependencies());
    const host = makeHost();
    await service.mount(host, () => undefined);
    await service.replaceSubject(meshAsset('mesh-a'));

    expect(assemblies[0]?.replaced).toEqual([payload]);
    service.resetCamera();
    service.frameCurrentSubject();
    expect(viewports[0]?.resetCamera).toHaveBeenCalledTimes(1);
    expect(viewports[0]?.frameBounds).toHaveBeenCalledTimes(2);

    const callsBeforeDispose = queryCalls;
    service.dispose();
    await service.replaceSubject(meshAsset('mesh-a'));
    expect(queryCalls).toBe(callsBeforeDispose);
  });

  it('loads a valid GUID through the preview AssetRegistry without a Runtime payload projection', async () => {
    const guid = '019d0000-0000-7000-8000-000000000020';
    const key = guid.replaceAll('-', '');
    const payload = {
      kind: 'mesh',
      vertices: new Float32Array([0, 0, 0]),
      submeshes: [],
      materialSlots: [{ slotName: 'Default' }],
    };
    previewPayloads.set(key, payload);
    const binding = { scopeId: 'game-a', generation: 3 };
    const service = new PreviewWorldService(createDependencies(binding));
    await service.mount(makeHost(), () => undefined);
    await service.replaceSubject(meshAsset(guid));

    expect(previewLoadCalls).toBe(1);
    expect(configuredBindings).toEqual([binding]);
    expect(queryCalls).toBe(0); // directly injected binding needs no carrier query
    expect(assemblies[0]?.replaced).toEqual([payload]);
  });

  it('loads a SceneAsset subject by instantiating it on the preview world (skeletal mesh, P1.2)', async () => {
    const guid = '019d0000-0000-7000-8000-000000000030';
    const key = guid.replaceAll('-', '');
    const skinGuid = '019d0000-0000-7000-8000-000000000031';
    const skinKey = skinGuid.replaceAll('-', '');
    const payload = { kind: 'scene', entities: [], skinGuids: [skinGuid] };
    previewPayloads.set(key, payload);
    // P1.4: the SkinAsset referenced by the scene must resolve so buildSkeletonTree
    // can parse its jointPaths into the read-only bone hierarchy.
    previewPayloads.set(skinKey, {
      kind: 'skin',
      guid: skinGuid,
      skeletonGuid: '019d0000-0000-7000-8000-000000000040',
      jointPaths: ['root', 'root/spine', 'root/spine/head'],
    });
    const service = new PreviewWorldService(createDependencies());
    const snapshots: { status: string; assetGuid?: string; bounds?: unknown; skeletonTree?: unknown }[] = [];
    await service.mount(makeHost(), (s) => snapshots.push(s as never));
    await service.replaceSubject(sceneAsset(guid, [skinGuid]));

    // Scene + Skin load = 2 loadByGuid calls.
    expect(previewLoadCalls).toBe(2);
    expect(sceneInstantiateCalls).toBe(1);
    expect(lastSceneInstantiateHandle).toBeDefined();
    // The placeholder cube is hidden while a Scene subject is active.
    expect(assemblies[0]?.hidden).toContain(true);
    // The mesh subject is NOT replaced by the scene payload.
    expect(assemblies[0]?.replaced).toEqual([]);
    const ready = snapshots.find((s) => s.status === 'ready');
    expect(ready?.assetGuid).toBe(guid);
    expect(ready?.bounds).toEqual({ center: [0, 1, 0], radius: 2.5 });
    // P1.4: the ready snapshot carries the parsed bone hierarchy.
    expect(Array.isArray(ready?.skeletonTree)).toBe(true);
    const tree = ready?.skeletonTree as { readonly name: string; readonly children: readonly unknown[] }[];
    expect(tree).toHaveLength(1);
    expect(tree[0]!.name).toBe('root');
    expect(tree[0]!.children).toHaveLength(1);
    expect((tree[0]!.children[0] as { readonly name: string }).name).toBe('spine');
  });

  it('emits no skeletonTree for a scene with no skins', async () => {
    const guid = '019d0000-0000-7000-8000-000000000032';
    previewPayloads.set(guid.replaceAll('-', ''), { kind: 'scene', entities: [], skinGuids: [] });
    const service = new PreviewWorldService(createDependencies());
    const snapshots: { status: string; skeletonTree?: unknown }[] = [];
    await service.mount(makeHost(), (s) => snapshots.push(s as never));
    await service.replaceSubject(sceneAsset(guid, []));
    const ready = snapshots.find((s) => s.status === 'ready');
    expect(ready?.skeletonTree).toBeUndefined();
  });

  it('despawns the previous Scene root when switching from a Scene to a Mesh subject', async () => {
    const sceneGuid = '019d0000-0000-7000-8000-000000000030';
    const meshGuid = '019d0000-0000-7000-8000-000000000020';
    previewPayloads.set(sceneGuid.replaceAll('-', ''), { kind: 'scene', entities: [], skinGuids: [] });
    previewPayloads.set(meshGuid.replaceAll('-', ''), {
      kind: 'mesh',
      vertices: new Float32Array([0, 0, 0]),
      submeshes: [],
      materialSlots: [],
    });
    const service = new PreviewWorldService(createDependencies());
    await service.mount(makeHost(), () => undefined);
    await service.replaceSubject(sceneAsset(sceneGuid));
    expect(sceneInstantiateCalls).toBe(1);
    expect(sceneDespawnCalls).toEqual([]);

    await service.replaceSubject(meshAsset(meshGuid));
    // Switching back to a mesh despawns the Scene root and restores the cube.
    expect(sceneDespawnCalls).toEqual([sceneRootHandle]);
    expect(assemblies[0]?.replaced).toHaveLength(1);
  });

  it('fails closed when Scene instantiate returns an error', async () => {
    const guid = '019d0000-0000-7000-8000-000000000030';
    previewPayloads.set(guid.replaceAll('-', ''), { kind: 'scene', entities: [], skinGuids: [] });
    sceneInstantiateOk = false;
    const service = new PreviewWorldService(createDependencies());
    const snapshots: { status: string; error?: string }[] = [];
    await service.mount(makeHost(), (s) => snapshots.push(s as never));
    await service.replaceSubject(sceneAsset(guid));

    expect(sceneInstantiateCalls).toBe(1);
    const failed = snapshots.find((s) => s.status === 'failed');
    expect(failed?.error).toContain('scene-instantiate-failed');
  });

  it('invalidates and reloads the same GUID when the producer catalog revision changes', async () => {
    const guid = '019d0000-0000-7000-8000-000000000020';
    const key = guid.replaceAll('-', '');
    previewPayloads.set(key, {
      kind: 'mesh',
      vertices: new Float32Array([0, 0, 0]),
      submeshes: [],
      materialSlots: [{ slotName: 'Body' }],
    });
    const service = new PreviewWorldService(createDependencies());
    await service.mount(makeHost(), () => undefined);
    await service.replaceSubject(meshAsset(guid), 'catalog-r1');
    await service.replaceSubject(meshAsset(guid), 'catalog-r2');

    expect(previewLoadCalls).toBe(2);
    expect(previewInvalidateCalls).toBe(1);
    expect(assemblies[0]?.replaced).toHaveLength(2);
  });

  it('configures the preview registry from the carrier binding projection', async () => {
    const binding = {
      schemaVersion: 'runtime-asset-binding-v1',
      gameId: 'game-a',
      scopeId: 'scope-a',
      generation: 1,
      status: 'ready',
      catalogUrl: '/__pack/scopes/scope-a/1/catalog.json',
      importUrlBase: '/__pack/scopes/scope-a/1/import',
      packageUrlBase: '/__pack/scopes/scope-a/1/asset',
    } as const;
    const service = new PreviewWorldService(createDependencies(null, binding));
    await service.mount(makeHost(), () => undefined);

    expect(configuredBindings).toEqual([binding]);
    expect(queryCalls).toBe(1);
    expect(createdBundlerOptions[0]).toMatchObject({
      importTransport: expect.objectContaining({ fetchPack: expect.any(Function) }),
    });
  });

  it('waits for the Runtime client handshake before constructing the preview App', async () => {
    const binding = {
      ...defaultRuntimeBinding,
      gameId: 'game-late',
      scopeId: 'scope-late',
      catalogUrl: '/__pack/scopes/scope-late/1/catalog.json',
      importUrlBase: '/__pack/scopes/scope-late/1/import',
      packageUrlBase: '/__pack/scopes/scope-late/1/asset',
    } as const;
    let snapshotCalls = 0;
    const dependencies = createDependencies(null, binding);
    const service = new PreviewWorldService({
      ...dependencies,
      getViewportRuntimeClientSnapshot: (() => ({
        status: ++snapshotCalls < 3 ? 'connecting' : 'ready',
      })) as PreviewWorldServiceDependencies['getViewportRuntimeClientSnapshot'],
    });

    await service.mount(makeHost(), () => undefined);

    expect(snapshotCalls).toBe(3);
    expect(queryCalls).toBe(1);
    expect(apps).toHaveLength(1);
    expect(configuredBindings).toEqual([binding]);
    expect(createdBundlerOptions[0]).toMatchObject({
      importTransport: expect.objectContaining({ fetchPack: expect.any(Function) }),
    });
  });

  it('fails closed without constructing an App when no Runtime binding becomes ready', async () => {
    const snapshots: Array<{ status: string; error?: string }> = [];
    const service = new PreviewWorldService(createDependencies(null));

    await service.mount(makeHost(), (snapshot) => snapshots.push(snapshot));

    expect(apps).toHaveLength(0);
    expect(createdBundlerOptions).toHaveLength(0);
    expect(snapshots.at(-1)).toEqual({
      status: 'failed',
      error: 'Preview runtime asset binding did not become ready before the bounded boot deadline.',
    });
  });

  it('fails closed when the preview registry cannot load a valid mesh dependency closure', async () => {
    const guid = '019d0000-0000-7000-8000-000000000021';
    payloads.set(guid, {
      kind: 'mesh',
      vertices: new Float32Array([0, 0, 0]),
      submeshes: [],
    });
    const snapshots: Array<{ status: string; error?: string }> = [];
    const service = new PreviewWorldService(createDependencies());
    await service.mount(makeHost(), (snapshot) => snapshots.push(snapshot));
    await service.replaceSubject(meshAsset(guid));

    expect(previewLoadCalls).toBe(1);
    expect(queryCalls).toBe(0); // directly injected binding needs no carrier query
    expect(assemblies[0]?.replaced).toEqual([]);
    expect(snapshots.at(-1)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('asset-not-found'),
    });
  });

  it('ignores a late payload from an older subject generation', async () => {
    let resolveA!: (payload: unknown) => void;
    const payloadA = new Promise<unknown>((resolve) => {
      resolveA = resolve;
    });
    const payloadB = { kind: 'mesh', vertices: new Float32Array([1, 0, 0]), submeshes: [] };
    payloads.set('mesh-a', payloadA);
    payloads.set('mesh-b', payloadB);

    const service = new PreviewWorldService(createDependencies());
    await service.mount(makeHost(), () => undefined);
    const first = service.replaceSubject(meshAsset('mesh-a'));
    await Promise.resolve();
    const second = service.replaceSubject(meshAsset('mesh-b'));
    await second;

    expect(assemblies[0]?.replaced).toEqual([payloadB]);
    resolveA({ kind: 'mesh', vertices: new Float32Array([2, 0, 0]), submeshes: [] });
    await first;
    expect(assemblies[0]?.replaced).toEqual([payloadB]);
  });
});

afterAll(() => {
  if (originalDocument === undefined) Reflect.deleteProperty(globalThis, 'document');
  else globalThis.document = originalDocument;
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
  else globalThis.window = originalWindow;
});
