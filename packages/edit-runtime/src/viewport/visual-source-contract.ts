/**
 * Editor-local structural mirror of `@forgeax/types/visual-generation`.
 *
 * forgeax-editor's standalone CI cannot resolve the private contracts package
 * as a workspace member, so this file keeps the viewport bridge free of that
 * dependency. Studio + marketplace still treat contracts as the SSOT; shapes
 * here must stay structurally compatible.
 */
export const VISUAL_INTENT_RESOURCE_KEY = 'ForgeaxVisualIntent' as const;
export const VISUAL_PRESENTATION_PROGRAM_RESOURCE_KEY = 'ForgeaxVisualPresentationProgram' as const;

export type VisualWorldRun = 'edit' | 'play';

export interface VisualResourceStore {
  hasResource(key: string): boolean;
  getResource<T>(key: string): T;
}

export interface VisualIntentEnvelope {
  readonly revision: number;
  readonly intent: unknown;
}

export interface VisualPresentationProgram {
  readonly revision: number;
  readonly journal: { readonly nextSequence: number };
}

export interface VisualWorldStamp {
  readonly epoch: number;
  readonly run: VisualWorldRun;
  readonly intentRevision?: number;
  readonly programRevision?: number;
  readonly transitionSequence: number;
}

export interface VisualSourceCamera {
  readonly entity: number;
  readonly position: readonly [number, number, number];
  readonly forward: readonly [number, number, number];
  readonly fovYDeg?: number;
}

export interface VisualViewportInfo {
  readonly width: number;
  readonly height: number;
}

export interface VisualSourceSnapshot {
  readonly available: boolean;
  readonly stamp?: VisualWorldStamp;
  readonly intent?: VisualIntentEnvelope;
  readonly program?: VisualPresentationProgram;
  readonly camera?: VisualSourceCamera;
  readonly viewport?: VisualViewportInfo;
}

export interface VisualViewportLease<TStream = unknown> {
  readonly stream: TStream;
  release(): void;
}

export interface VisualPresentationEntry {
  readonly continuityKey: string;
  readonly [key: string]: unknown;
}

export interface VisualPresentationManifest {
  readonly version: 2;
  readonly entries: readonly VisualPresentationEntry[];
}

export interface VisualPriorEntry {
  readonly continuityKey: string;
  readonly image: string;
  readonly label?: string;
}

export interface VisualPriorManifest {
  readonly version: 1;
  readonly entries: readonly VisualPriorEntry[];
}

export interface VisualSource<TStream = unknown, TImage = unknown> {
  getSnapshot(): VisualSourceSnapshot;
  subscribe(listener: () => void): () => void;
  leaseViewportTrack(fps: number): VisualViewportLease<TStream>;
  hasPriorCatalog(): Promise<boolean>;
  resolveSeedImage(continuityKey: string): Promise<TImage>;
  resolvePresentation(continuityKey: string): Promise<VisualPresentationEntry | undefined>;
  dispose(): void;
}

export function getVisualIntent(store: VisualResourceStore): VisualIntentEnvelope | undefined {
  if (!store.hasResource(VISUAL_INTENT_RESOURCE_KEY)) return undefined;
  const value = store.getResource<unknown>(VISUAL_INTENT_RESOURCE_KEY);
  if (!value || typeof value !== 'object') {
    throw new Error('ForgeaxVisualIntent resource is not an object');
  }
  const revision = (value as { revision?: unknown }).revision;
  if (typeof revision !== 'number' || !Number.isFinite(revision)) {
    throw new Error('ForgeaxVisualIntent.revision must be a finite number');
  }
  return value as VisualIntentEnvelope;
}

export function getVisualPresentationProgram(
  store: VisualResourceStore,
): VisualPresentationProgram | undefined {
  if (!store.hasResource(VISUAL_PRESENTATION_PROGRAM_RESOURCE_KEY)) return undefined;
  const value = store.getResource<unknown>(VISUAL_PRESENTATION_PROGRAM_RESOURCE_KEY);
  if (!value || typeof value !== 'object') {
    throw new Error('ForgeaxVisualPresentationProgram resource is not an object');
  }
  const revision = (value as { revision?: unknown }).revision;
  const journal = (value as { journal?: unknown }).journal;
  if (typeof revision !== 'number' || !Number.isFinite(revision)) {
    throw new Error('ForgeaxVisualPresentationProgram.revision must be a finite number');
  }
  if (!journal || typeof journal !== 'object') {
    throw new Error('ForgeaxVisualPresentationProgram.journal must be an object');
  }
  return value as VisualPresentationProgram;
}

function requireUniqueContinuityKeys(
  kind: string,
  entries: readonly { continuityKey: string }[],
): void {
  const seen = new Map<string, number>();
  entries.forEach((entry, index) => {
    const previous = seen.get(entry.continuityKey);
    if (previous !== undefined) {
      throw new Error(
        `Duplicate ${kind} continuity key "${entry.continuityKey}" (entries ${previous} and ${index})`,
      );
    }
    seen.set(entry.continuityKey, index);
  });
}

export function parseVisualPriorManifest(value: unknown): VisualPriorManifest {
  if (!value || typeof value !== 'object') throw new Error('visual-priors manifest must be an object');
  const version = (value as { version?: unknown }).version;
  const entries = (value as { entries?: unknown }).entries;
  if (version !== 1) throw new Error('visual-priors manifest version must be 1');
  if (!Array.isArray(entries)) throw new Error('visual-priors manifest entries must be an array');
  const normalized = entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`visual-priors entry ${index} must be an object`);
    }
    const continuityKey = (entry as { continuityKey?: unknown }).continuityKey;
    const image = (entry as { image?: unknown }).image;
    if (typeof continuityKey !== 'string' || continuityKey.length === 0) {
      throw new Error(`visual-priors entry ${index} needs continuityKey`);
    }
    if (typeof image !== 'string' || image.length === 0) {
      throw new Error(`visual-priors entry ${index} needs image`);
    }
    const label = (entry as { label?: unknown }).label;
    return {
      continuityKey,
      image,
      ...(typeof label === 'string' && label.length > 0 ? { label } : {}),
    };
  });
  requireUniqueContinuityKeys('visual-priors', normalized);
  return { version: 1, entries: normalized };
}

export function parseVisualPresentationManifest(value: unknown): VisualPresentationManifest {
  if (!value || typeof value !== 'object') {
    throw new Error('visual-presentation manifest must be an object');
  }
  const version = (value as { version?: unknown }).version;
  const entries = (value as { entries?: unknown }).entries;
  if (version !== 2) throw new Error('visual-presentation manifest version must be 2');
  if (!Array.isArray(entries)) {
    throw new Error('visual-presentation manifest entries must be an array');
  }
  const normalized = entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`visual-presentation entry ${index} must be an object`);
    }
    const continuityKey = (entry as { continuityKey?: unknown }).continuityKey;
    if (typeof continuityKey !== 'string' || continuityKey.length === 0) {
      throw new Error(`visual-presentation entry ${index} needs continuityKey`);
    }
    return entry as VisualPresentationEntry;
  });
  requireUniqueContinuityKeys('visual-presentation', normalized);
  return { version: 2, entries: normalized };
}
