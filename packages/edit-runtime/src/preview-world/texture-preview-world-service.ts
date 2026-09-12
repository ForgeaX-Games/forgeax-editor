// @forgeax/editor-edit-runtime — Texture preview runtime owner (STD-01).
//
// Owns the bounded mini-world lifecycle for the UE-style Texture Editor page.
// The panel is a thin shell; this service is the sole creator/disposer of its
// canvas, createApp instance, transient world, and orthographic navigation.

import { createApp, type App } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  createTexturePreviewPrimitive,
  previewSnapshot,
  type TexturePreviewPrimitive,
  type TextureBinding,
} from '@forgeax/engine-preview';
import type { TextureAsset } from '@forgeax/engine-types';
import {
  createEngineFacade,
  getViewportRuntimeClientSnapshot,
  queryViewportRuntimeProjection,
  type SelectedAsset,
} from '@forgeax/editor-core';
import {
  assembleTexturePreviewWorld,
  type TexturePreviewAssembly,
  type TexturePreviewOrthoView,
  DEFAULT_TEXTURE_ORTHO_VIEW,
} from './assemble-texture-preview-world';
import { getPreviewRuntimeBinding } from './preview-runtime-binding';
import { createPreviewBundlerOptions } from '../viewport/preview-bundler-options';
import {
  DEFAULT_TEXTURE_PREVIEW_VIEW_STATE,
  type TexturePreviewViewState,
} from './texture-preview-view-state';

const PREVIEW_BOOT_TIMEOUT_MS = 8_000;
const RUNTIME_BINDING_RETRY_ATTEMPTS = 20;
const RUNTIME_BINDING_RETRY_DELAY_MS = 100;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function queryRuntimeBinding(): Promise<import('@forgeax/engine-types').RuntimeAssetBinding | undefined> {
  for (let attempt = 0; attempt < RUNTIME_BINDING_RETRY_ATTEMPTS; attempt += 1) {
    if (getViewportRuntimeClientSnapshot().status === 'ready') {
      try {
        const projection = await queryViewportRuntimeProjection<import('@forgeax/engine-types').RuntimeAssetBinding>({
          kind: 'assets.runtime-binding',
        });
        if (
          projection.status === 'ready'
          && projection.value.schemaVersion === 'runtime-asset-binding-v1'
        ) {
          return projection.value;
        }
      } catch {
        // Retry against the next ready snapshot within the bounded window.
      }
    }
    if (attempt + 1 < RUNTIME_BINDING_RETRY_ATTEMPTS) {
      await delay(RUNTIME_BINDING_RETRY_DELAY_MS);
    }
  }
  return undefined;
}

export type TexturePreviewStatus = 'booting' | 'empty' | 'loading' | 'ready' | 'failed';

export interface TexturePreviewSnapshot {
  readonly status: TexturePreviewStatus;
  readonly assetGuid?: string;
  readonly width?: number;
  readonly height?: number;
  readonly format?: string;
  readonly error?: string;
  readonly previewOperationId?: 'texture.preview';
  readonly previewSource?: 'engine';
}

export type TexturePreviewStateListener = (snapshot: TexturePreviewSnapshot) => void;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message);
  }
  return String(error);
}

function textureChannels(format: string): number {
  if (format.includes('rgba') || format.includes('bgra')) return 4;
  if (format.includes('rgb')) return 3;
  if (format.includes('rg')) return 2;
  return 1;
}

function textureBindingFromPayload(guid: string, payload: Record<string, unknown>): TextureBinding | undefined {
  const width = payload.width;
  const height = payload.height;
  const format = payload.format;
  const colorSpace = payload.colorSpace;
  const mipLevels = payload.mipLevelCount ?? (payload.mipmap === true ? 1 : undefined);
  if (
    typeof width !== 'number' || !Number.isSafeInteger(width) || width < 1
    || typeof height !== 'number' || !Number.isSafeInteger(height) || height < 1
    || typeof format !== 'string' || format.length === 0
    || (colorSpace !== 'linear' && colorSpace !== 'srgb' && colorSpace !== 'hdr')
    || typeof mipLevels !== 'number' || !Number.isSafeInteger(mipLevels) || mipLevels < 1
  ) return undefined;
  return {
    guid,
    width,
    height,
    format,
    colorSpace,
    alpha: Boolean(payload.alpha ?? (format.includes('rgba') || format.includes('bgra'))),
    mipLevels,
    channels: textureChannels(format),
  };
}

function isTextureSubject(asset: SelectedAsset | null): asset is SelectedAsset {
  return asset !== null && (asset.kind === 'texture' || asset.kind === 'image');
}

export class TexturePreviewWorldService {
  private host: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private app: App | null = null;
  private assembly: TexturePreviewAssembly | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private listener: TexturePreviewStateListener | null = null;
  private pendingAsset: SelectedAsset | null = null;
  private pendingRevision: string | undefined;
  private loadedSubject: { readonly guid: string; readonly revision?: string } | undefined;
  private generation = 0;
  private disposed = false;
  private ready: Promise<void> = Promise.resolve();
  private viewState: TexturePreviewViewState = DEFAULT_TEXTURE_PREVIEW_VIEW_STATE;
  private orthoView: TexturePreviewOrthoView = { ...DEFAULT_TEXTURE_ORTHO_VIEW };
  private pointerCleanup: (() => void) | null = null;

  static create(): TexturePreviewWorldService {
    return new TexturePreviewWorldService();
  }

  mount(host: HTMLDivElement, listener: TexturePreviewStateListener): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.host !== null) return this.ready;

    this.host = host;
    this.listener = listener;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'texture-preview-canvas';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'none';
    host.appendChild(this.canvas);
    this.emit({ status: 'booting' });

    this.ready = this.boot();
    return this.ready;
  }

  async replaceSubject(asset: SelectedAsset | null, revision?: string): Promise<void> {
    if (this.disposed) return;
    this.pendingAsset = asset;
    this.pendingRevision = revision;
    await this.ready;
    await this.loadSubject(asset, revision);
  }

  setViewState(next: TexturePreviewViewState): void {
    this.viewState = next;
    this.assembly?.applyViewState(next);
    this.syncCheckerboardClass();
  }

  getViewState(): TexturePreviewViewState {
    return this.viewState;
  }

  resetView(): void {
    this.orthoView = { ...DEFAULT_TEXTURE_ORTHO_VIEW };
    this.assembly?.resetOrthoView();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pointerCleanup?.();
    this.pointerCleanup = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    try { this.app?.stop(); } catch { /* already stopped */ }
    this.app = null;
    this.assembly = null;
    if (this.canvas?.parentElement === this.host) this.host?.removeChild(this.canvas);
    this.canvas = null;
    this.host = null;
    this.listener = null;
  }

  private emit(snapshot: TexturePreviewSnapshot): void {
    this.listener?.(snapshot);
  }

  private syncCheckerboardClass(): void {
    if (this.host === null) return;
    this.host.classList.toggle('texture-preview-checkerboard', this.viewState.checkerboardVisible);
  }

  private installNavigation(): void {
    const canvas = this.canvas;
    if (canvas === null) return;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.1 : 0.9;
      this.orthoView = {
        ...this.orthoView,
        zoom: Math.min(32, Math.max(0.25, this.orthoView.zoom * factor)),
      };
      this.assembly?.applyOrthoView(this.orthoView);
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 1 && !(event.button === 0 && event.altKey)) return;
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging || this.assembly === null) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const spanX = Math.abs(this.assembly.dimensions.width / Math.max(1, rect.width));
      const spanY = Math.abs(this.assembly.dimensions.height / Math.max(1, rect.height));
      const dx = ((event.clientX - lastX) / rect.width) * spanX * 2 / this.orthoView.zoom;
      const dy = ((event.clientY - lastY) / rect.height) * spanY * 2 / this.orthoView.zoom;
      lastX = event.clientX;
      lastY = event.clientY;
      this.orthoView = {
        ...this.orthoView,
        panX: this.orthoView.panX - dx,
        panY: this.orthoView.panY + dy,
      };
      this.assembly.applyOrthoView(this.orthoView);
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      try { canvas.releasePointerCapture(event.pointerId); } catch { /* noop */ }
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    this.pointerCleanup = () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
    };
  }

  private async loadSubject(asset: SelectedAsset | null, revision?: string): Promise<void> {
    if (this.disposed || this.assembly === null || this.app === null) return;
    const generation = ++this.generation;

    if (!isTextureSubject(asset)) {
      this.emit({ status: 'empty' });
      return;
    }

    this.emit({ status: 'loading', assetGuid: asset.guid });
    const parsed = AssetGuid.parse(asset.guid);
    const previewAssets = this.app.assets;
    let texture: TextureAsset | undefined;

    if (parsed.ok && previewAssets !== undefined) {
      if (this.loadedSubject?.guid.toLowerCase() === asset.guid.toLowerCase()
        && this.loadedSubject.revision !== revision) {
        previewAssets.invalidate(asset.guid);
      }
      const loaded = await previewAssets.loadByGuid<TextureAsset>(parsed.value);
      if (this.disposed || generation !== this.generation) return;
      if (!loaded.ok) {
        this.emit({
          status: 'failed',
          assetGuid: asset.guid,
          error: `Preview AssetRegistry could not load texture: ${loaded.error.code}`,
        });
        return;
      }
      if (loaded.value.kind !== 'texture') {
        this.emit({
          status: 'failed',
          assetGuid: asset.guid,
          error: `Resolved '${asset.guid}' as '${loaded.value.kind}', expected 'texture'.`,
        });
        return;
      }
      texture = loaded.value;
    } else if (asset.payload.kind === 'texture') {
      texture = asset.payload as unknown as TextureAsset;
    }

    if (texture === undefined) {
      this.emit({
        status: 'failed',
        assetGuid: asset.guid,
        error: 'Texture preview requires a loadable TextureAsset payload.',
      });
      return;
    }

    const textureHandle = this.app.world.allocSharedRef('TextureAsset', texture);
    // Engine realizes referenced texture PODs through its render-owned residency path.

    const binding = textureBindingFromPayload(asset.guid, asset.payload);
    let primitive: TexturePreviewPrimitive | undefined;
    if (binding !== undefined) {
      primitive = createTexturePreviewPrimitive({
        subjectGuid: asset.guid,
        snapshot: previewSnapshot(asset.guid),
        binding,
      });
      this.assembly.setEnginePrimitive(primitive);
    }

    this.assembly.replaceTexture(texture, textureHandle, this.viewState);
    this.loadedSubject = { guid: asset.guid, revision };
    this.emit({
      status: 'ready',
      assetGuid: asset.guid,
      width: texture.width,
      height: texture.height,
      format: String(texture.format),
      previewOperationId: 'texture.preview',
      previewSource: 'engine',
    });
  }

  private async boot(): Promise<void> {
    const host = this.host;
    const canvas = this.canvas;
    if (host === null || canvas === null) return;

    try {
      const runtimeBinding = getPreviewRuntimeBinding() ?? await queryRuntimeBinding();
      if (runtimeBinding === undefined) {
        this.emit({
          status: 'failed',
          error: 'Preview runtime asset binding did not become ready before the bounded boot deadline.',
        });
        return;
      }
      const previewBundlerOptions = await createPreviewBundlerOptions(runtimeBinding);
      let abandonPrimary = false;
      const primary = createApp(
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
        abandonPrimary = true;
        const rhiNull = await import('@forgeax/engine-rhi-null');
        created = await createApp(
          canvas,
          { pointerLockAllowed: () => false, rhi: rhiNull.rhi as never },
          previewBundlerOptions,
        );
      }
      if (!created.ok) {
        const rhiNull = await import('@forgeax/engine-rhi-null');
        created = await createApp(
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
        this.app.assets?.configureRuntimeBinding(runtimeBinding);
      }
      const facade = createEngineFacade(this.app.world as never, this.app.assets);
      this.assembly = assembleTexturePreviewWorld(facade);

      const syncSize = () => {
        const rect = host.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.floor(rect.width * dpr));
        const height = Math.max(1, Math.floor(rect.height * dpr));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
      };
      syncSize();
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(syncSize);
        this.resizeObserver.observe(host);
      }

      this.installNavigation();
      this.syncCheckerboardClass();
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
