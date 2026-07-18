/**
 * Studio visual-source facade.
 *
 * This is the only bridge from the in-process editor runtime to generated
 * visual presenters. It deliberately exposes plain world snapshots and media
 * leases, never the editor's debug globals or a DOM selector convention.
 */
import {
  getVisualIntent,
  type VisualIntentEnvelope,
  getVisualPresentationProgram,
  type VisualPresentationProgram,
  type VisualPresentationEntry,
  type VisualPresentationManifest,
  type VisualSource as ContractVisualSource,
  type VisualSourceCamera as ContractVisualSourceCamera,
  type VisualSourceSnapshot as ContractVisualSourceSnapshot,
  type VisualViewportInfo as ContractVisualViewportInfo,
  type VisualViewportLease as ContractVisualViewportLease,
  parseVisualPriorManifest,
  parseVisualPresentationManifest,
  type VisualPriorManifest,
  type VisualResourceStore,
  type VisualWorldRun,
  type VisualWorldStamp,
} from './visual-source-contract';
import { Camera, Transform } from '@forgeax/engine-runtime';

export type VisualSource = ContractVisualSource<MediaStream, Blob>;
export type VisualSourceCamera = ContractVisualSourceCamera;
export type VisualSourceSnapshot = ContractVisualSourceSnapshot;
export type VisualViewportInfo = ContractVisualViewportInfo;
export type VisualViewportLease = ContractVisualViewportLease<MediaStream>;

interface ComponentReadableWorld extends VisualResourceStore {
  get(
    entity: number,
    component: unknown,
  ): { ok: true; value: Record<string, unknown> } | { ok: false };
}

interface VisualGateway {
  readonly activeWorld: ComponentReadableWorld;
  readonly mode: VisualWorldRun;
  subscribe(listener: () => void): () => void;
}

interface EditorVisualHost {
  readonly generation: number;
  readonly gateway: VisualGateway;
  readonly canvas: HTMLCanvasElement;
  readonly gameRoot?: string;
  readonly getActiveCameraEntity: () => number | undefined;
}

let nextHostGeneration = 1;
let activeHost: EditorVisualHost | undefined;
const hostListeners = new Set<() => void>();

function notifyHostChange(): void {
  for (const listener of hostListeners) listener();
}

function subscribeHostChanges(listener: () => void): () => void {
  hostListeners.add(listener);
  return () => hostListeners.delete(listener);
}

/**
 * Called by ViewportComponent at boot and undone by its realm teardown. The
 * registration is intentionally internal to edit-runtime; external consumers
 * only create a source through the editor facade.
 */
export function registerEditorVisualHost(host: Omit<EditorVisualHost, 'generation'>): () => void {
  const registration: EditorVisualHost = {
    ...host,
    generation: nextHostGeneration++,
  };
  activeHost = registration;
  notifyHostChange();

  return () => {
    if (activeHost?.generation !== registration.generation) return;
    activeHost = undefined;
    notifyHostChange();
  };
}

function numericArray(value: unknown): ArrayLike<number> | undefined {
  if (Array.isArray(value)) return value;
  // `ArrayBuffer.isView` also accepts DataView, which has no indexed elements.
  if (ArrayBuffer.isView(value) && 'length' in value) {
    return value as unknown as ArrayLike<number>;
  }
  return undefined;
}

function tuple3(value: unknown): [number, number, number] | undefined {
  const items = numericArray(value);
  if (!items || items.length < 3) return undefined;
  const [x, y, z] = [Number(items[0]), Number(items[1]), Number(items[2])];
  if (![x, y, z].every(Number.isFinite)) return undefined;
  return [x, y, z];
}

function forwardFromQuat(value: unknown): [number, number, number] | undefined {
  const items = numericArray(value);
  if (!items || items.length < 4) return undefined;
  const [x, y, z, w] = [Number(items[0]), Number(items[1]), Number(items[2]), Number(items[3])];
  if (![x, y, z, w].every(Number.isFinite)) return undefined;
  // Rotate the local forward vector [0, 0, -1] by the component's xyzw quaternion.
  return [
    -2 * (x * z + w * y),
    -2 * (y * z - w * x),
    -1 + 2 * (x * x + y * y),
  ];
}

function readCamera(
  world: ComponentReadableWorld,
  entity: number | undefined,
): VisualSourceCamera | undefined {
  if (entity === undefined) return undefined;
  try {
    const transform = world.get(entity, Transform);
    const camera = world.get(entity, Camera);
    if (!transform.ok || !camera.ok) return undefined;
    const position = tuple3(transform.value.pos);
    const forward = forwardFromQuat(transform.value.quat);
    if (!position || !forward) return undefined;
    const fov = Number(camera.value.fov);
    return {
      entity,
      position,
      forward,
      ...(Number.isFinite(fov) && fov > 0 ? { fovYDeg: fov * (180 / Math.PI) } : {}),
    };
  } catch {
    return undefined;
  }
}

function safeIntent(world: ComponentReadableWorld): VisualIntentEnvelope | undefined {
  try {
    return getVisualIntent(world);
  } catch {
    return undefined;
  }
}

function safePresentationProgram(
  world: ComponentReadableWorld,
): VisualPresentationProgram | undefined {
  try {
    return getVisualPresentationProgram(world);
  } catch {
    return undefined;
  }
}

function snapshotFingerprint(snapshot: VisualSourceSnapshot): string {
  return JSON.stringify({
    available: snapshot.available,
    stamp: snapshot.stamp,
    program: snapshot.program,
    camera: snapshot.camera,
    viewport: snapshot.viewport,
  });
}

function resolveGameAssetPath(gameRoot: string, relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/');
  if (
    normalized.length === 0
    || normalized.startsWith('/')
    || normalized.split('/').some((part) => part === '..')
  ) {
    throw new Error(`Visual prior image path must stay inside the game root: "${relativePath}"`);
  }
  return `${gameRoot.replace(/\/+$/, '')}/${normalized}`;
}

class EditorVisualSourceImpl implements VisualSource {
  private readonly listeners = new Set<() => void>();
  private readonly releaseHostListener: () => void;
  private releaseGatewayListener?: () => void;
  private observedHost?: EditorVisualHost;
  private observedWorld?: ComponentReadableWorld;
  private worldEpoch = 0;
  private frameId?: number;
  private lastFingerprint = '';
  private disposed = false;
  private readonly viewportLeases = new Set<VisualViewportLease>();
  private priorManifest?: { readonly gameRoot: string; readonly value: VisualPriorManifest };
  private readonly priorImages = new Map<string, Blob>();
  private presentationManifest?: { readonly gameRoot: string; readonly value: VisualPresentationManifest };
  private presentationManifestLoadedGameRoot?: string;

  constructor() {
    this.releaseHostListener = subscribeHostChanges(() => {
      this.rebindHost();
      this.notifyIfChanged();
    });
    this.rebindHost();
  }

  getSnapshot(): VisualSourceSnapshot {
    if (this.disposed) {
      return { available: false };
    }
    this.rebindHost();
    const host = this.observedHost;
    if (!host) return { available: false };

    let world: ComponentReadableWorld;
    let run: VisualWorldRun;
    try {
      world = host.gateway.activeWorld;
      run = host.gateway.mode;
    } catch {
      return { available: false };
    }
    if (this.observedWorld !== world) {
      // A play transition replaces the authoritative world while retaining the
      // same canvas. Existing consumers must explicitly obtain a fresh lease so
      // an async adapter cannot keep presenting frames labelled with the old
      // epoch.
      this.releaseViewportLeases();
      this.observedWorld = world;
      this.worldEpoch += 1;
    }

    const intent = safeIntent(world);
    const program = safePresentationProgram(world);
    const camera = readCamera(world, host.getActiveCameraEntity());
    const canvas = host.canvas;
    const viewport = {
      width: canvas.width,
      height: canvas.height,
    };
    const stamp: VisualWorldStamp = {
      epoch: this.worldEpoch,
      run,
      ...(intent ? { intentRevision: intent.revision } : {}),
      ...(program ? { programRevision: program.revision } : {}),
      transitionSequence: program ? program.journal.nextSequence - 1 : 0,
    };
    return {
      available: true,
      stamp,
      ...(intent ? { intent } : {}),
      ...(program ? { program } : {}),
      ...(camera ? { camera } : {}),
      viewport,
    };
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    this.startFrameObservation();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopFrameObservation();
    };
  }

  leaseViewportTrack(fps: number): VisualViewportLease {
    const host = this.requireHost();
    if (!Number.isFinite(fps) || fps <= 0) {
      throw new RangeError('Viewport track FPS must be a positive finite number');
    }
    if (typeof host.canvas.captureStream !== 'function') {
      throw new Error('Viewport capture is unavailable in this browser');
    }
    const stream = host.canvas.captureStream(fps);
    let released = false;
    const lease: VisualViewportLease = {
      stream,
      release: () => {
        if (released) return;
        released = true;
        for (const track of stream.getTracks()) track.stop();
        this.viewportLeases.delete(lease);
      },
    };
    this.viewportLeases.add(lease);
    return lease;
  }

  async hasPriorCatalog(): Promise<boolean> {
    try {
      await this.loadPriorManifest();
      return true;
    } catch {
      return false;
    }
  }

  async resolveSeedImage(continuityKey: string): Promise<Blob> {
    const { gameRoot, value } = await this.loadPriorManifest();
    const cacheKey = `${gameRoot}\u0000${continuityKey}`;
    const cached = this.priorImages.get(cacheKey);
    if (cached) return cached;

    const entry = value.entries.find((candidate) => candidate.continuityKey === continuityKey);
    if (!entry) {
      throw new Error(`No visual prior is registered for continuity key "${continuityKey}"`);
    }
    const imagePath = resolveGameAssetPath(gameRoot, entry.image);
    const response = await fetch(
      `/api/files/raw?path=${encodeURIComponent(imagePath)}`,
      { cache: 'force-cache' },
    );
    if (!response.ok) {
      throw new Error(`Could not load visual prior "${continuityKey}" (${response.status})`);
    }
    const image = await response.blob();
    if (!image.type.startsWith('image/')) {
      throw new Error(`Visual prior "${continuityKey}" is not an image`);
    }
    this.priorImages.set(cacheKey, image);
    return image;
  }

  async resolvePresentation(continuityKey: string): Promise<VisualPresentationEntry | undefined> {
    const manifest = await this.loadPresentationManifest();
    if (!manifest) return undefined;
    const entry = manifest.value.entries.find((candidate) => candidate.continuityKey === continuityKey);
    if (!entry) {
      throw new Error(`No visual presentation is registered for continuity key "${continuityKey}"`);
    }
    return entry;
  }

  private async loadPriorManifest(): Promise<{
    readonly gameRoot: string;
    readonly value: VisualPriorManifest;
  }> {
    if (this.disposed) {
      throw new Error('Visual source is disposed');
    }
    this.rebindHost();
    const host = this.observedHost;
    const gameRoot = host?.gameRoot?.trim();
    if (!host || !gameRoot) {
      throw new Error('The active Studio game does not provide a visual-priors catalog');
    }
    if (this.priorManifest?.gameRoot === gameRoot) {
      return this.priorManifest;
    }
    const manifestPath = `${gameRoot}/visual-priors/manifest.json`;
    const response = await fetch(
      `/api/files?path=${encodeURIComponent(manifestPath)}`,
      { cache: 'no-store' },
    );
    const payload = await response.json().catch(() => ({})) as { content?: unknown; error?: unknown };
    if (!response.ok || typeof payload.content !== 'string') {
      const detail = typeof payload.error === 'string' ? `: ${payload.error}` : '';
      throw new Error(`Could not load the visual-priors manifest${detail}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.content);
    } catch {
      throw new Error('The visual-priors manifest is not valid JSON');
    }
    const manifest = { gameRoot, value: parseVisualPriorManifest(parsed) };
    this.priorManifest = manifest;
    return manifest;
  }

  private async loadPresentationManifest(): Promise<{
    readonly gameRoot: string;
    readonly value: VisualPresentationManifest;
  } | undefined> {
    if (this.disposed) {
      throw new Error('Visual source is disposed');
    }
    this.rebindHost();
    const host = this.observedHost;
    const gameRoot = host?.gameRoot?.trim();
    if (!host || !gameRoot) return undefined;
    const manifestPath = `${gameRoot}/visual-presentation/manifest.json`;
    const response = await fetch(
      `/api/files?path=${encodeURIComponent(manifestPath)}`,
      { cache: 'no-store' },
    );
    if (response.status === 404) {
      this.presentationManifest = undefined;
      this.presentationManifestLoadedGameRoot = gameRoot;
      return undefined;
    }
    const payload = await response.json().catch(() => ({})) as { content?: unknown; error?: unknown };
    if (!response.ok || typeof payload.content !== 'string') {
      const detail = typeof payload.error === 'string' ? `: ${payload.error}` : '';
      throw new Error(`Could not load the visual-presentation manifest${detail}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.content);
    } catch {
      throw new Error('The visual-presentation manifest is not valid JSON');
    }
    const manifest = {
      gameRoot,
      value: parseVisualPresentationManifest(parsed),
    };
    this.presentationManifest = manifest;
    this.presentationManifestLoadedGameRoot = gameRoot;
    return manifest;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopFrameObservation();
    this.releaseHostListener();
    this.releaseGatewayListener?.();
    this.releaseGatewayListener = undefined;
    this.releaseViewportLeases();
    this.priorManifest = undefined;
    this.priorImages.clear();
    this.presentationManifest = undefined;
    this.presentationManifestLoadedGameRoot = undefined;
    this.listeners.clear();
  }

  private requireHost(): EditorVisualHost {
    this.rebindHost();
    if (!this.observedHost) {
      throw new Error('No active Studio viewport is available for generated visuals');
    }
    return this.observedHost;
  }

  private rebindHost(): void {
    const nextHost = activeHost;
    if (this.observedHost?.generation === nextHost?.generation) return;
    this.releaseGatewayListener?.();
    this.releaseGatewayListener = undefined;
    this.releaseViewportLeases();
    this.observedHost = nextHost;
    this.observedWorld = undefined;
    this.priorManifest = undefined;
    this.priorImages.clear();
    this.presentationManifest = undefined;
    this.presentationManifestLoadedGameRoot = undefined;
    this.worldEpoch += 1;
    if (nextHost) {
      this.releaseGatewayListener = nextHost.gateway.subscribe(() => this.notifyIfChanged());
    }
  }

  private releaseViewportLeases(): void {
    for (const lease of [...this.viewportLeases]) lease.release();
  }

  private startFrameObservation(): void {
    if (this.frameId !== undefined || this.listeners.size === 0) return;
    const tick = (): void => {
      this.frameId = undefined;
      this.notifyIfChanged();
      if (this.listeners.size > 0 && !this.disposed) {
        this.frameId = requestAnimationFrame(tick);
      }
    };
    this.frameId = requestAnimationFrame(tick);
  }

  private stopFrameObservation(): void {
    if (this.frameId === undefined) return;
    cancelAnimationFrame(this.frameId);
    this.frameId = undefined;
  }

  private notifyIfChanged(): void {
    const fingerprint = snapshotFingerprint(this.getSnapshot());
    if (fingerprint === this.lastFingerprint) return;
    this.lastFingerprint = fingerprint;
    for (const listener of this.listeners) listener();
  }
}

export function createEditorVisualSource(): VisualSource {
  return new EditorVisualSourceImpl();
}
