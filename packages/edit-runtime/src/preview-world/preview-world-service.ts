// @forgeax/editor-edit-runtime — Mesh preview runtime owner (STD-01/T1.1).
//
// A preview panel is allowed to own a bounded mini-world because it renders a
// real asset. The panel does not own that lifecycle: this service is the sole
// creator/disposer of its canvas, createApp instance, transient world, and
// viewport interaction.

import { createApp, type App } from '@forgeax/engine-app';
import type { MeshAsset } from '@forgeax/engine-types';
import {
  createEngineFacade,
  getViewportRuntimeClientSnapshot,
  queryViewportRuntimeProjection,
  type SelectedAsset,
} from '@forgeax/editor-core';
import { assembleMeshPreviewWorld, type MeshPreviewAssembly, type MeshPreviewBounds } from './assemble-mesh-preview-world';
import { createViewport, type Viewport } from '../viewport/viewport';
import { createPreviewBundlerOptions } from '../viewport/preview-bundler-options';
const PREVIEW_BOOT_TIMEOUT_MS = 8_000;

export type MeshPreviewStatus = 'booting' | 'empty' | 'loading' | 'ready' | 'failed';
export type PreviewWorldKind = 'mesh';

export interface MeshPreviewSnapshot {
  readonly status: MeshPreviewStatus;
  readonly assetGuid?: string;
  readonly bounds?: MeshPreviewBounds;
  readonly error?: string;
}
export type MeshPreviewStateListener = (snapshot: MeshPreviewSnapshot) => void;

export interface PreviewWorldServiceDependencies {
  readonly createApp: typeof createApp;
  readonly createEngineFacade: typeof createEngineFacade;
  readonly getViewportRuntimeClientSnapshot: typeof getViewportRuntimeClientSnapshot;
  readonly queryViewportRuntimeProjection: typeof queryViewportRuntimeProjection;
  readonly assembleMeshPreviewWorld: typeof assembleMeshPreviewWorld;
  readonly createViewport: typeof createViewport;
}

const DEFAULT_DEPENDENCIES: PreviewWorldServiceDependencies = {
  createApp,
  createEngineFacade,
  getViewportRuntimeClientSnapshot,
  queryViewportRuntimeProjection,
  assembleMeshPreviewWorld,
  createViewport,
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
  private generation = 0;
  private disposed = false;
  private ready: Promise<void> = Promise.resolve();

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
  async replaceSubject(asset: SelectedAsset | null): Promise<void> {
    if (this.disposed) return;
    this.pendingAsset = asset;
    await this.ready;
    await this.loadSubject(asset);
  }

  resetCamera(): void {
    this.viewport?.resetCamera();
  }

  frameCurrentSubject(): void {
    if (this.assembly !== null) this.viewport?.frameBounds(this.assembly.bounds);
  }

  private async loadSubject(asset: SelectedAsset | null): Promise<void> {
    if (this.disposed || this.assembly === null || this.viewport === null) return;

    const generation = ++this.generation;
    if (asset === null) {
      this.emit({ status: 'empty' });
      return;
    }
    if (asset.kind !== 'mesh') {
      this.emit({ status: 'failed', assetGuid: asset.guid, error: `Unsupported preview kind: ${asset.kind}` });
      return;
    }

    this.emit({ status: 'loading', assetGuid: asset.guid });
    const runtimePayload = await queryRuntimeMeshPayload(asset.guid, this.dependencies);
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
      this.viewport.frameBounds(bounds);
      this.emit({ status: 'ready', assetGuid: asset.guid, bounds });
    } catch (error) {
      this.emit({ status: 'failed', assetGuid: asset.guid, error: errorMessage(error) });
    }
  }

  /** Stop the preview runtime and release every DOM/runtime owner. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    try { this.viewport?.dispose(); } catch { /* already disposed */ }
    this.viewport = null;
    try { this.app?.stop(); } catch { /* already stopped */ }
    this.app = null;
    this.assembly = null;
    const host = this.host;
    const canvas = this.canvas;
    if (host && canvas?.parentElement === host) host.removeChild(canvas);
    this.canvas = null;
    this.host = null;
    this.listener = null;
    this.pendingAsset = null;
  }

  private emit(snapshot: MeshPreviewSnapshot): void {
    this.listener?.(snapshot);
  }

  private async boot(): Promise<void> {
    const host = this.host;
    const canvas = this.canvas;
    if (!host || !canvas) return;
    const previewBundlerOptions = createPreviewBundlerOptions();

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
      const facade = this.dependencies.createEngineFacade(this.app.world as never);
      this.assembly = this.dependencies.assembleMeshPreviewWorld(facade);
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
        await this.loadSubject(this.pendingAsset);
      }
    } catch (error) {
      this.emit({ status: 'failed', error: errorMessage(error) });
    }
  }
}
