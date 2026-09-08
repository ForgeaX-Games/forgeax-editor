// @forgeax/editor-edit-runtime — Mesh preview runtime owner (STD-01/T1.1).
//
// A preview panel is allowed to own a bounded mini-world because it renders a
// real asset. The panel does not own that lifecycle: this service is the sole
// creator/disposer of its canvas, createApp instance, transient world, and
// viewport interaction.

import { createApp, type App } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { createMeshPreviewPrimitive, meshBindingFromPayload, previewSnapshot } from '@forgeax/engine-preview';
import type { EntityHandle } from '@forgeax/engine-ecs';
import type { MeshAsset, RuntimeAssetBinding, SceneAsset, SkinAsset } from '@forgeax/engine-types';import {
  createEngineFacade,
  getViewportRuntimeClientSnapshot,
  queryViewportRuntimeProjection,
  type SelectedAsset,
} from '@forgeax/editor-core';
import { assembleMeshPreviewWorld, type MeshPreviewAssembly, type MeshPreviewBounds } from './assemble-mesh-preview-world';
import { installBoundsOverlay } from './bounds-overlay';
import { buildSkeletonTree, type SkeletonTreeNode } from './skeleton-tree';
import { installSkeletonOverlay } from './skeleton-overlay';
import { createViewport, type Viewport } from '../viewport/viewport';
import { createPreviewBundlerOptions } from '../viewport/preview-bundler-options';
import { getPreviewRuntimeBinding } from './preview-runtime-binding';
const PREVIEW_BOOT_TIMEOUT_MS = 8_000;
const RUNTIME_BINDING_RETRY_ATTEMPTS = 20;
const RUNTIME_BINDING_RETRY_DELAY_MS = 100;

export type MeshPreviewStatus = 'booting' | 'empty' | 'loading' | 'ready' | 'failed';
export type PreviewWorldKind = 'mesh';

export interface MeshPreviewSnapshot {
  readonly status: MeshPreviewStatus;
  readonly assetGuid?: string;
  readonly bounds?: MeshPreviewBounds;
  readonly error?: string;
  /** Actual defaults loaded into the preview mini-world, exposed for deterministic verification. */
  readonly materialDefaultGuids?: readonly string[];
  /**
   * Read-only bone hierarchy for the active Scene subject (P1.4), parsed from
   * the union of every SkinAsset's `jointPaths`. Absent for non-scene subjects
   * (mesh subjects carry no skeleton).
   */
  readonly skeletonTree?: readonly SkeletonTreeNode[];
  readonly previewOperationId?: 'mesh.preview';
  readonly previewSource?: 'engine';
}
export type MeshPreviewStateListener = (snapshot: MeshPreviewSnapshot) => void;

export interface PreviewWorldServiceDependencies {
  readonly createApp: typeof createApp;
  readonly createEngineFacade: typeof createEngineFacade;
  readonly getViewportRuntimeClientSnapshot: typeof getViewportRuntimeClientSnapshot;
  readonly queryViewportRuntimeProjection: typeof queryViewportRuntimeProjection;
  readonly assembleMeshPreviewWorld: typeof assembleMeshPreviewWorld;
  readonly createViewport: typeof createViewport;
  readonly getRuntimeBinding: typeof getPreviewRuntimeBinding;
  /**
   * Registers the Bounds wireframe overlay (P1.1) on the preview world.
   * Injected so headless tests stay deterministic without a real World
   * (mirrors the assembleMeshPreviewWorld injection pattern).
   */
  readonly installBoundsOverlay: typeof installBoundsOverlay;
  /**
   * Registers the Skeleton wireframe overlay (P1.3) on the preview world.
   * Injected for the same headless-determinism reason as installBoundsOverlay.
   */
  readonly installSkeletonOverlay: typeof installSkeletonOverlay;
}

const DEFAULT_DEPENDENCIES: PreviewWorldServiceDependencies = {
  createApp,
  createEngineFacade,
  getViewportRuntimeClientSnapshot,
  queryViewportRuntimeProjection,
  assembleMeshPreviewWorld,
  createViewport,
  getRuntimeBinding: getPreviewRuntimeBinding,
  installBoundsOverlay,
  installSkeletonOverlay,
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message);
  }
  return String(error);
}

function initialOrbit(bounds: MeshPreviewBounds): {
  target: [number, number, number];
  dist: number;
} {
  return {
    target: [bounds.center[0], bounds.center[1], bounds.center[2]],
    dist: Math.max(2, bounds.radius * 3.2),
  };
}

function selectedMeshPayload(asset: SelectedAsset): MeshAsset | undefined {
  const payload = asset.payload;
  if (
    payload.kind !== 'mesh'
    || !('vertices' in payload)
    || !('submeshes' in payload)
  ) {
    return undefined;
  }
  return payload as unknown as MeshAsset;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function queryRuntimeMeshPayload(
  guid: string,
  dependencies: PreviewWorldServiceDependencies,
): Promise<MeshAsset | undefined> {
  // The shell panel can mount before the Runtime MessagePort handshake has
  // completed. Retry the read-only projection briefly; the Runtime remains the
  // sole AssetRegistry owner and performs the actual GUID load.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (dependencies.getViewportRuntimeClientSnapshot().status === 'ready') {
      try {
        const projection = await dependencies.queryViewportRuntimeProjection<{
          readonly guid: string;
          readonly payload: unknown;
        }>({ kind: 'assets.payload', guid });
        if (projection.status === 'ready') {
          const value = projection.value;
          if (
            value !== null
            && typeof value === 'object'
            && 'payload' in value
            && value.payload !== null
            && typeof value.payload === 'object'
            && 'kind' in value.payload
            && value.payload.kind === 'mesh'
          ) {
            return value.payload as MeshAsset;
          }
        }
      } catch {
        // Runtime reconnects and stale generations are expected during page
        // transitions; the generation guard in loadSubject decides whether
        // the eventual result is still relevant.
      }
    }
    await delay(100);
  }
  return undefined;
}

async function queryRuntimeBinding(
  dependencies: PreviewWorldServiceDependencies,
): Promise<RuntimeAssetBinding | undefined> {
  // Panel mount and Runtime MessagePort readiness are independent. The import
  // transport is immutable after createApp, so wait for the authority instead
  // of constructing an App that can never load GUID dependencies.
  for (let attempt = 0; attempt < RUNTIME_BINDING_RETRY_ATTEMPTS; attempt += 1) {
    if (dependencies.getViewportRuntimeClientSnapshot().status === 'ready') {
      try {
        const projection = await dependencies.queryViewportRuntimeProjection<RuntimeAssetBinding>({
          kind: 'assets.runtime-binding',
        });
        if (
          projection.status === 'ready'
          && projection.value.schemaVersion === 'runtime-asset-binding-v1'
        ) {
          return projection.value;
        }
      } catch {
        // A carrier generation can turn stale while the panel is mounting.
        // Retry against the next ready snapshot within the bounded window.
      }
    }
    if (attempt + 1 < RUNTIME_BINDING_RETRY_ATTEMPTS) {
      await delay(RUNTIME_BINDING_RETRY_DELAY_MS);
    }
  }
  return undefined;
}

/**
 * Owns one independent Mesh preview application.
 *
 * `mount`/`dispose` are idempotent at the lifecycle boundary. Asset loads use
 * a generation token so a late result cannot replace a newer subject.
 */
export class PreviewWorldService {
  private readonly dependencies: PreviewWorldServiceDependencies;
  private host: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private app: App | null = null;
  private viewport: Viewport | null = null;
  private assembly: MeshPreviewAssembly | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private listener: MeshPreviewStateListener | null = null;
  private pendingAsset: SelectedAsset | null = null;
  private pendingRevision: string | undefined;
  private loadedSubject: { readonly guid: string; readonly revision?: string } | undefined;
  private generation = 0;
  private disposed = false;
  private ready: Promise<void> = Promise.resolve();
  private boundsOverlayVisible = true;
  private skeletonOverlayVisible = true;
  /** Scene subject root (skeletal mesh). Non-null only while a SceneAsset is
   *  the active subject; despawned on the next subject swap. */
  private sceneRoot: EntityHandle | null = null;
  /** Engine facade (stored at boot) — used to despawn a Scene subject root. */
  private facade: ReturnType<typeof createEngineFacade> | null = null;

  static create(kind: PreviewWorldKind): PreviewWorldService {
    if (kind !== 'mesh') throw new Error(`Unsupported preview world kind: ${kind}`);
    return new PreviewWorldService();
  }

  constructor(dependencies: PreviewWorldServiceDependencies = DEFAULT_DEPENDENCIES) {
    this.dependencies = dependencies;
  }

  get isAlive(): boolean {
    return !this.disposed && this.host !== null && this.app !== null;
  }

  /** Create the service and start its independent canvas/runtime. */
  mount(host: HTMLDivElement, listener: MeshPreviewStateListener): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.host !== null) return this.ready;

    this.host = host;
    this.listener = listener;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'mesh-preview-canvas';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'none';
    host.appendChild(this.canvas);
    this.emit({ status: 'booting' });

    this.ready = this.boot();
    return this.ready;
  }

  /** Replace the preview subject without replacing the preview application. */
  async replaceSubject(asset: SelectedAsset | null, revision?: string): Promise<void> {
    if (this.disposed) return;
    this.pendingAsset = asset;
    this.pendingRevision = revision;
    await this.ready;
    await this.loadSubject(asset, revision);
  }

  resetCamera(): void {
    this.viewport?.resetCamera();
  }

  frameCurrentSubject(): void {
    if (this.assembly !== null) this.viewport?.frameBounds(this.assembly.bounds);
  }

  /** Toggle the Bounds wireframe overlay (P1.1). No-op before boot completes. */
  setBoundsOverlayVisible(visible: boolean): void {
    this.boundsOverlayVisible = visible;
  }

  isBoundsOverlayVisible(): boolean {
    return this.boundsOverlayVisible;
  }

  /** Toggle the Skeleton wireframe overlay (P1.3). Draws joints + bone lines
   *  for the active Scene subject; no-op for mesh subjects. */
  setSkeletonOverlayVisible(visible: boolean): void {
    this.skeletonOverlayVisible = visible;
  }

  isSkeletonOverlayVisible(): boolean {
    return this.skeletonOverlayVisible;
  }

  private async loadSubject(asset: SelectedAsset | null, revision?: string): Promise<void> {
    if (this.disposed || this.assembly === null || this.viewport === null) return;

    const generation = ++this.generation;
    if (asset === null) {
      this.despawnSceneRoot();
      this.emit({ status: 'empty' });
      return;
    }
    if (asset.kind === 'scene') {
      await this.loadSceneSubject(asset, revision, generation);
      return;
    }
    if (asset.kind !== 'mesh') {
      this.emit({ status: 'failed', assetGuid: asset.guid, error: `Unsupported preview kind: ${asset.kind}` });
      return;
    }

    // Switching back to a mesh subject: tear down any active Scene root so
    // its spawned joints + Skin subtree is released before the cube returns.
    this.despawnSceneRoot();
    this.emit({ status: 'loading', assetGuid: asset.guid });
    // The preview App owns a normal Engine AssetRegistry configured with the
    // same runtime binding/import transport as the viewport. Loading by GUID
    // here brings the mesh and its transitive material/texture refs into that
    // registry, so MeshAsset defaults resolve through the ordinary render path.
    // The Runtime projection remains the compatibility fallback for injected
    // headless tests and hosts that do not expose a load-capable registry.
    let runtimePayload: MeshAsset | undefined;
    const parsed = AssetGuid.parse(asset.guid);
    const previewAssets = this.app?.renderer?.assets;
    if (parsed.ok && previewAssets !== undefined) {
      if (this.loadedSubject?.guid.toLowerCase() === asset.guid.toLowerCase()
        && this.loadedSubject.revision !== revision) {
        previewAssets.invalidate(asset.guid);
      }
      const loaded = await previewAssets.loadByGuid<MeshAsset>(parsed.value);
      if (this.disposed || generation !== this.generation) return;
      if (!loaded.ok) {
        const detail = 'detail' in loaded.error
          ? JSON.stringify(loaded.error.detail)
          : undefined;
        const expected = 'expected' in loaded.error ? String(loaded.error.expected) : undefined;
        const hint = 'hint' in loaded.error ? String(loaded.error.hint) : undefined;
        this.emit({
          status: 'failed',
          assetGuid: asset.guid,
          error: [
            `Preview AssetRegistry could not load the mesh dependency closure: ${loaded.error.code}`,
            expected === undefined ? undefined : `expected: ${expected}`,
            hint === undefined ? undefined : `hint: ${hint}`,
            detail,
          ].filter((part): part is string => part !== undefined).join('; '),
        });
        return;
      }
      if (loaded.value.kind !== 'mesh') {
        this.emit({
          status: 'failed',
          assetGuid: asset.guid,
          error: `Preview AssetRegistry resolved '${asset.guid}' as '${loaded.value.kind}', not 'mesh'.`,
        });
        return;
      }
      runtimePayload = loaded.value;
      this.loadedSubject = { guid: asset.guid, ...(revision === undefined ? {} : { revision }) };
    }
    if (!parsed.ok || previewAssets === undefined) {
      runtimePayload = await queryRuntimeMeshPayload(asset.guid, this.dependencies);
    }
    if (this.disposed || generation !== this.generation) return;

    // A complete selection-time payload is useful for tests and in-process
    // hosts, but the authoritative cross-realm path is the Runtime projection
    // above. Content Browser pack-index rows commonly carry only identity
    // metadata, so never pass those raw JSON rows directly to allocSharedRef.
    const selectedPayload = Object.keys(asset.payload).length > 0
      ? selectedMeshPayload(asset)
      : undefined;
    const payload = runtimePayload ?? selectedPayload;
    if (payload === undefined) {
      this.emit({
        status: 'failed',
        assetGuid: asset.guid,
        error: 'Mesh payload could not be loaded from the Runtime Asset Registry.',
      });
      return;
    }

    try {
      const bounds = this.assembly.replaceSubject(payload as MeshAsset);
      const binding = meshBindingFromPayload(asset.guid, payload as MeshAsset);
      if (binding) {
        this.assembly.setEnginePrimitive?.(createMeshPreviewPrimitive({
          subjectGuid: asset.guid,
          snapshot: previewSnapshot(asset.guid),
          binding,
        }));
      }
      this.viewport.frameBounds(bounds);
      this.emit({
        status: 'ready',
        assetGuid: asset.guid,
        bounds,
        previewOperationId: 'mesh.preview',
        previewSource: 'engine',
        materialDefaultGuids: (payload.materialSlots ?? []).flatMap((slot) => (
          slot.defaultMaterial === undefined ? [] : [AssetGuid.format(slot.defaultMaterial)]
        )),
      });
    } catch (error) {
      this.emit({ status: 'failed', assetGuid: asset.guid, error: errorMessage(error) });
    }
  }

  /** Despawn the active Scene subject root (joints + Skin subtree), if any. */
  private despawnSceneRoot(): void {
    if (this.sceneRoot !== null) {
      try { this.facade?.despawnScene(this.sceneRoot); } catch { /* already despawned */ }
      this.sceneRoot = null;
    }
  }

  /**
   * Load every SkinAsset referenced by `sceneAsset.skinGuids` and parse the
   * union of their `jointPaths` into a read-only bone hierarchy (P1.4). A
   * missing skinGuid is non-fatal: the preview still renders, the tree just
   * omits that skin's joints (with a console warn). Returns an empty array
   * when the scene carries no skins (e.g. a static-only scene).
   */
  private async buildSkeletonTree(
    sceneAsset: SceneAsset,
    previewAssets: { loadByGuid<T>(guid: AssetGuid): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> },
  ): Promise<readonly SkeletonTreeNode[]> {
    const skinGuids = sceneAsset.skinGuids ?? [];
    if (skinGuids.length === 0) return [];
    const allJointPaths: string[] = [];
    for (const skinGuid of skinGuids) {
      const parsed = AssetGuid.parse(skinGuid);
      if (!parsed.ok) {
        console.warn(`[SkeletonTree] invalid skinGuid '${skinGuid}'; skipped`);
        continue;
      }
      const loaded = await previewAssets.loadByGuid<SkinAsset>(parsed.value);
      if (!loaded.ok) {
        console.warn(`[SkeletonTree] could not load SkinAsset '${skinGuid}'; skipped`);
        continue;
      }
      const skinAsset = loaded.value;
      if (skinAsset.kind !== 'skin') {
        console.warn(`[SkeletonTree] '${skinGuid}' resolved as '${skinAsset.kind}', not 'skin'; skipped`);
        continue;
      }
      for (const path of skinAsset.jointPaths) allJointPaths.push(path);
    }
    return buildSkeletonTree(allJointPaths);
  }

  /**
   * Load a SceneAsset subject (rigged / skeletal mesh) by instantiating it on
   * the preview world. The engine AssetRegistry.instantiate spine spawns the
   * joint hierarchy + Skin components and auto-wires Skin.joints via
   * postSpawnResolveJoints — the same path Play uses for the default scene.
   * Bounds use a conservative default until per-subtree aggregation lands; the
   * user can Frame All manually.
   */
  private async loadSceneSubject(
    asset: SelectedAsset,
    revision: string | undefined,
    generation: number,
  ): Promise<void> {
    if (this.disposed || this.assembly === null || this.viewport === null || this.app === null) return;

    // Replacing any prior subject: tear down the old Scene root (or restore the
    // mesh cube) before spawning the new one.
    this.despawnSceneRoot();
    this.assembly.hideMeshSubject();
    this.emit({ status: 'loading', assetGuid: asset.guid });

    const parsed = AssetGuid.parse(asset.guid);
    const previewAssets = this.app.renderer?.assets;
    if (!parsed.ok || previewAssets === undefined) {
      this.emit({
        status: 'failed',
        assetGuid: asset.guid,
        error: 'Scene preview requires a load-capable preview AssetRegistry (Runtime binding unavailable).',
      });
      return;
    }

    if (this.loadedSubject?.guid.toLowerCase() === asset.guid.toLowerCase()
      && this.loadedSubject.revision !== revision) {
      previewAssets.invalidate(asset.guid);
    }

    const loaded = await previewAssets.loadByGuid<SceneAsset>(parsed.value);
    if (this.disposed || generation !== this.generation) return;
    if (!loaded.ok) {
      const hint = 'hint' in loaded.error ? String(loaded.error.hint) : undefined;
      this.emit({
        status: 'failed',
        assetGuid: asset.guid,
        error: [
          `Preview AssetRegistry could not load the scene dependency closure: ${loaded.error.code}`,
          hint === undefined ? undefined : `hint: ${hint}`,
        ].filter((part): part is string => part !== undefined).join('; '),
      });
      return;
    }
    if (loaded.value.kind !== 'scene') {
      this.emit({
        status: 'failed',
        assetGuid: asset.guid,
        error: `Preview AssetRegistry resolved '${asset.guid}' as '${loaded.value.kind}', not 'scene'.`,
      });
      return;
    }

    const sceneAsset = loaded.value;
    try {
      if (this.facade === null) {
        this.emit({
          status: 'failed',
          assetGuid: asset.guid,
          error: 'Preview engine facade is not available (boot incomplete).',        });
        return;
      }
      const handle = this.facade.allocSharedRef('SceneAsset', sceneAsset);
      const inst = previewAssets.instantiate(handle, this.app.world);
      if (this.disposed || generation !== this.generation) return;
      if (!inst.ok) {
        this.emit({
          status: 'failed',
          assetGuid: asset.guid,
          error: `Scene instantiate failed: ${inst.error.code}`,
        });
        return;
      }
      this.sceneRoot = inst.value;
      this.loadedSubject = { guid: asset.guid, ...(revision === undefined ? {} : { revision }) };
      // Conservative bounds: the scene root sits at the origin; radius 2.5
      // frames a typical rigged asset. Per-subtree AABB aggregation is a
      // follow-up; the user can Frame All manually in the meantime.
      const bounds: MeshPreviewBounds = { center: [0, 1, 0], radius: 2.5 };
      this.viewport.frameBounds(bounds);
      // P1.4: build the read-only bone hierarchy from the scene's SkinAssets.
      // `loadByGuid<SceneAsset>` already recursively pulled every SkinAsset
      // (the scene envelope's refs[] cross-edge), so each skinGuid resolves
      // synchronously here. The union of all jointPaths feeds buildSkeletonTree,
      // which dedupes shared prefixes so a joint referenced by two skins shows
      // once. A failed SkinAsset load is non-fatal: the preview still renders,
      // the tree just omits that skin's joints (with a console warn).
      const skeletonTree = await this.buildSkeletonTree(sceneAsset, previewAssets);
      this.emit({
        status: 'ready',
        assetGuid: asset.guid,
        bounds,
        ...(skeletonTree.length === 0 ? {} : { skeletonTree }),
      });
    } catch (error) {
      this.emit({ status: 'failed', assetGuid: asset.guid, error: errorMessage(error) });
    }
  }

  /** Stop the preview runtime and release every DOM/runtime owner. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.despawnSceneRoot();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    try { this.viewport?.dispose(); } catch { /* already disposed */ }
    this.viewport = null;
    try { this.app?.stop(); } catch { /* already stopped */ }
    this.app = null;
    this.assembly = null;
    this.facade = null;
    const host = this.host;
    const canvas = this.canvas;
    if (host && canvas?.parentElement === host) host.removeChild(canvas);
    this.canvas = null;
    this.host = null;
    this.listener = null;
    this.pendingAsset = null;
    this.pendingRevision = undefined;
    this.loadedSubject = undefined;
  }

  private emit(snapshot: MeshPreviewSnapshot): void {
    this.listener?.(snapshot);
  }

  private async boot(): Promise<void> {
    const host = this.host;
    const canvas = this.canvas;
    if (!host || !canvas) return;
    // Resolve the one Runtime authority before constructing App. The import
    // transport is a construction-time bundler capability; configuring only
    // the registry after createApp cannot recover import-on-demand when the
    // editor-core module identity differs from the active Viewport carrier.
    const runtimeBinding = this.dependencies.getRuntimeBinding()
      ?? await queryRuntimeBinding(this.dependencies);
    if (runtimeBinding === undefined) {
      this.emit({
        status: 'failed',
        error: 'Preview runtime asset binding did not become ready before the bounded boot deadline.',
      });
      return;
    }
    const previewBundlerOptions = await createPreviewBundlerOptions(runtimeBinding);

    try {
      let abandonPrimary = false;
      const primary = this.dependencies.createApp(
        canvas,
        { pointerLockAllowed: () => false },
        previewBundlerOptions,
      ).then((result) => {
        if (abandonPrimary && result.ok) {
          try { result.value.stop(); } catch { /* timed-out app never became owned */ }
        }
        return result;
      });
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        timeoutId = setTimeout(() => resolve(undefined), PREVIEW_BOOT_TIMEOUT_MS);
      });
      let created = await Promise.race([primary, timeout]);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (created === undefined) {
        // A lost/unconfigured browser surface can leave WebGPU device startup
        // pending indefinitely. Do not leave the panel in "booting" forever:
        // abandon that result and use the existing null-RHI test/headless
        // fallback. If the primary promise eventually resolves, the callback
        // above stops its otherwise-unowned App.
        abandonPrimary = true;
        const rhiNull = await import('@forgeax/engine-rhi-null');
        created = await this.dependencies.createApp(
          canvas,
          { pointerLockAllowed: () => false, rhi: rhiNull.rhi as never },
          previewBundlerOptions,
        );
      }
      if (!created.ok) {
        // The null RHI keeps the lifecycle and panel testable in headless CI;
        // production WebGPU remains the first and only real rendering path.
        const rhiNull = await import('@forgeax/engine-rhi-null');
        created = await this.dependencies.createApp(
          canvas,
          { pointerLockAllowed: () => false, rhi: rhiNull.rhi as never },
          previewBundlerOptions,
        );
      }
      if (!created.ok) {
        this.emit({ status: 'failed', error: errorMessage(created.error) });
        return;
      }
      if (this.disposed) {
        created.value.stop();
        return;
      }

      this.app = created.value;
      if (runtimeBinding !== undefined) {
        // createApp receives the transport at construction, while the registry
        // still needs the same authority-bearing scope to configure its pack
        // index. Keep both halves on the active Runtime binding so Preview
        // loadByGuid resolves the same catalog as Edit and Play.
        this.app.renderer?.assets.configureRuntimeBinding(runtimeBinding);
      }
      const facade = this.dependencies.createEngineFacade(this.app.world as never, this.app.renderer?.assets);
      this.facade = facade;
      this.assembly = this.dependencies.assembleMeshPreviewWorld(facade);
      // P1.1: Bounds wireframe overlay. Reads the assembly's current subject
      // AABB each frame and draws the 12-edge gizmo through the engine DebugDraw
      // owned by this preview App. The subject stays at the origin (scale 1),
      // so its local AABB is its world AABB.
      this.dependencies.installBoundsOverlay({
        world: this.app.world,
        debugDraw: this.app.debugDraw,
        getAabb: () => this.assembly?.subjectAabb ?? null,
        isVisible: () => this.boundsOverlayVisible,
      });
      this.dependencies.installSkeletonOverlay({
        world: this.app.world,
        debugDraw: this.app.debugDraw,
        getRoot: () => this.sceneRoot,
        isVisible: () => this.skeletonOverlayVisible,
      });
      const orbit = initialOrbit(this.assembly.bounds);
      this.viewport = this.dependencies.createViewport({
        canvas,
        engine: facade,
        editorEngine: facade,
        camera: this.assembly.camera,
        initialOrbit: { target: orbit.target, dist: orbit.dist, yaw: 0.55, pitch: -0.35 },
        interaction: 'preview',
      });

      const syncSize = () => {
        const rect = host.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.floor(rect.width * dpr));
        const height = Math.max(1, Math.floor(rect.height * dpr));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
          this.viewport?.refresh();
        }
      };
      syncSize();
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(syncSize);
        this.resizeObserver.observe(host);
      }

      this.app.start();
      this.emit({ status: 'empty' });
      if (this.pendingAsset !== null) {
        await this.loadSubject(this.pendingAsset, this.pendingRevision);
      }
    } catch (error) {
      this.emit({ status: 'failed', error: errorMessage(error) });
    }
  }
}
