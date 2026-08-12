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
  readonly start: ReturnType<typeof mock>;
  readonly stop: ReturnType<typeof mock>;
};
type FakeViewport = {
  readonly resetCamera: ReturnType<typeof mock>;
  readonly frameBounds: ReturnType<typeof mock>;
  readonly refresh: ReturnType<typeof mock>;
  readonly dispose: ReturnType<typeof mock>;
};
type FakeAssembly = {
  readonly bounds: {
    readonly center: readonly [number, number, number];
    readonly radius: number;
  };
  readonly replaced: unknown[];
  replaceSubject(mesh: unknown): FakeAssembly['bounds'];
};

const apps: FakeApp[] = [];
const viewports: FakeViewport[] = [];
const assemblies: FakeAssembly[] = [];
const payloads = new Map<string, unknown | Promise<unknown>>();
let queryCalls = 0;

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

function createDependencies(): PreviewWorldServiceDependencies {
  return {
    createApp: (async () => {
      const app: FakeApp = {
        world: {},
        start: mock(() => undefined),
        stop: mock(() => undefined),
      };
      apps.push(app);
      return { ok: true as const, value: app };
    }) as unknown as PreviewWorldServiceDependencies['createApp'],
    createEngineFacade: (() => ({})) as unknown as PreviewWorldServiceDependencies['createEngineFacade'],
    getViewportRuntimeClientSnapshot: (() => ({ status: 'ready' })) as PreviewWorldServiceDependencies['getViewportRuntimeClientSnapshot'],
    queryViewportRuntimeProjection: (async ({ guid }: { readonly guid: string }) => {
      queryCalls += 1;
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
        replaceSubject(mesh) {
          this.replaced.push(mesh);
          return this.bounds;
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
        dispose: mock(() => undefined),
      };
      viewports.push(viewport);
      return viewport;
    }) as PreviewWorldServiceDependencies['createViewport'],
  };
}

beforeEach(() => {
  apps.length = 0;
  viewports.length = 0;
  assemblies.length = 0;
  payloads.clear();
  queryCalls = 0;
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
