import type {
  ExecutionBootstrapValue,
  Plugin,
} from '@forgeax/engine-app';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { RenderFeature, Renderer } from '@forgeax/engine-render';

export const PLAY_EXECUTION_PROTOCOL = 'forgeax.play-execution/v1' as const;

export type PlayRendererProvenance = {
  readonly identity: string;
  readonly generation: number;
  readonly backend: string;
  readonly caps: readonly string[];
};

const PLAY_RENDERER_IDENTITY_RE = /^renderer-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function isSortedUniqueStrings(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry.length > 0)) return false;
  const seen = new Set(value);
  if (seen.size !== value.length) return false;
  return value.every((entry, index) => index === 0 || value[index - 1]! <= entry);
}

export function isPlayRendererProvenance(value: unknown): value is PlayRendererProvenance {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const provenance = value as Partial<PlayRendererProvenance>;
  return typeof provenance.identity === 'string'
    && PLAY_RENDERER_IDENTITY_RE.test(provenance.identity)
    && typeof provenance.generation === 'number'
    && Number.isSafeInteger(provenance.generation)
    && provenance.generation > 0
    && typeof provenance.backend === 'string'
    && provenance.backend.trim().length > 0
    && isSortedUniqueStrings(provenance.caps);
}

/**
 * Mint the renderer envelope in the realm that owns the live Renderer. The
 * caller supplies the realm-local generation; this helper refuses to turn
 * missing renderer facts into a plausible-looking diagnostic.
 */
export function createPlayRendererProvenance(
  renderer: Pick<Renderer, 'inspect'>,
  generation: number,
): PlayRendererProvenance | null {
  if (!Number.isSafeInteger(generation) || generation <= 0) return null;
  let inspection: ReturnType<Renderer['inspect']>;
  try {
    inspection = renderer.inspect();
  } catch {
    return null;
  }
  const caps = inspection.capabilities;
  const backend = caps.backendKind;
  if (typeof backend !== 'string' || backend.trim().length === 0
    || typeof caps !== 'object' || caps === null || Array.isArray(caps)) return null;
  const capNames = Object.keys(caps).filter((name) => name !== 'backendKind').sort();
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (typeof uuid !== 'string' || uuid.length === 0) return null;
    const provenance = {
      identity: `renderer-${uuid}`,
      generation,
      backend,
      caps: Object.freeze(capNames),
    } satisfies PlayRendererProvenance;
    return isPlayRendererProvenance(provenance) ? Object.freeze(provenance) : null;
  } catch {
    return null;
  }
}

export interface PlayExecutionBootstrapData {
  readonly protocol: typeof PLAY_EXECUTION_PROTOCOL;
  readonly gameId: string;
  readonly gameEntryUrl: string;
  readonly gameData?: ExecutionBootstrapValue;
  readonly physics?: 'rapier-3d' | 'rapier-2d';
  readonly runtimeBinding?: ExecutionBootstrapValue;
  readonly packIndexUrl?: string;
  readonly gamePluginModules: readonly {
    readonly clientPath: string;
    readonly url: string;
  }[];
}

/** Disposable, structured-clone-safe facts projected out of the authoritative
 * execution realm. Host diagnostics and tests consume this snapshot instead
 * of reaching for a main-thread shadow World. */
export interface PlayExecutionRuntimeDiagnostics {
  readonly entityCount: number;
  readonly activeComponents: readonly string[];
  readonly entities: readonly PlayExecutionEntityDiagnostics[];
  readonly vfxRuntimePresent: boolean;
  readonly queuedIntents: number;
  readonly runtimeDiagnostics: readonly ExecutionBootstrapValue[];
  readonly featurePass?: string;
  readonly featureStatus?: string;
  readonly featureError?: ExecutionBootstrapValue;
  /** Renderer-owned frame facts used to distinguish a healthy loop from a
   * frame that only clears because no camera/renderables reached the record
   * stage. Kept as a small POD projection so it is safe across the realm
   * boundary and useful to both human diagnostics and AI verification. */
  readonly render?: {
    readonly frustum: { readonly culled: number; readonly total: number };
    readonly visibility: { readonly explicitlyHidden: number };
    readonly scene: {
      readonly worldEntitiesScanned: number;
      readonly projectionRecords: number;
      readonly candidateCount: number;
      readonly batchCount: number;
      readonly ineligible: number;
      readonly gpuStatus: string;
    };
    readonly meshMaterialBindings: readonly {
      readonly worldId: number;
      readonly entityKey: number;
      readonly bindingCount: number;
      readonly diagnosticCount: number;
    }[];
    readonly bindGroupCreates: number;
    readonly passCount: number;
  };
}

export interface PlayExecutionEntityDiagnostics {
  readonly entity: number;
  readonly components: readonly string[];
  readonly name?: string;
  readonly meshFilter?: { readonly hasAsset: boolean };
  readonly meshRenderer?: { readonly materialCount: number };
  readonly childOf?: { readonly parent: number };
}

export interface PlayExecutionDiagnosticsStore {
  accept(message: PlayExecutionRealmMessage): boolean;
  snapshot(): PlayExecutionRuntimeDiagnostics | undefined;
}

/** Owns only the latest disposable projection; it cannot mutate or recreate
 * the authoritative Worker World. */
export function createPlayExecutionDiagnosticsStore(): PlayExecutionDiagnosticsStore {
  let current: PlayExecutionRuntimeDiagnostics | undefined;
  return {
    accept(message): boolean {
      if (message.kind !== 'runtime-diagnostics') return false;
      current = message.diagnostics;
      return true;
    },
    snapshot: () => current,
  };
}

export type PlayExecutionRealmMessage =
  | {
      readonly protocol: typeof PLAY_EXECUTION_PROTOCOL;
      readonly kind: 'realm-ready';
      readonly renderer: PlayRendererProvenance;
    }
  | {
      readonly protocol: typeof PLAY_EXECUTION_PROTOCOL;
      readonly kind: 'heartbeat';
      readonly fps: number;
      readonly sentinel: number;
    }
  | {
      readonly protocol: typeof PLAY_EXECUTION_PROTOCOL;
      readonly kind: 'runtime-diagnostics';
      readonly diagnostics: PlayExecutionRuntimeDiagnostics;
    };

export interface PlayExecutionHostContext {
  readonly port: MessagePort;
  readonly uiRoot: HTMLElement;
  readonly app: {
    readonly input?: { setPointerLockAllowed?(allowed: boolean): void };
  };
  registerCleanup(cleanup: () => void): () => void;
}

export type PlayExecutionHostEntry = (
  context: PlayExecutionHostContext,
) => void | Promise<void>;

export interface PlayExecutionModule {
  readonly default: (
    data: ExecutionBootstrapValue | undefined,
  ) => PlayExecutionGame | Promise<PlayExecutionGame>;
  readonly host?: PlayExecutionHostEntry;
}

/**
 * Editor-owned preparation contract layered on top of Engine 7dd's native
 * Cordis execution entry. The wrapper supplies renderer/asset/diagnostic
 * services, then invokes the game body exactly once in that realm.
 */
export interface PlayExecutionGameContext {
  readonly world: World;
  readonly renderer: Renderer;
  readonly assets: AssetRegistry;
  readonly port?: MessagePort;
  registerCleanup(cleanup: () => void | Promise<void>): void;
}

export interface PlayExecutionGame {
  readonly features?: readonly RenderFeature<unknown>[];
  readonly plugins?: readonly Plugin[];
  run(context: PlayExecutionGameContext): void | Promise<void>;
}

export function parsePlayExecutionBootstrapData(
  value: ExecutionBootstrapValue | undefined,
): PlayExecutionBootstrapData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Play execution bootstrap data must be an object');
  }
  const data = value as unknown as Partial<PlayExecutionBootstrapData>;
  if (
    data.protocol !== PLAY_EXECUTION_PROTOCOL ||
    typeof data.gameId !== 'string' ||
    typeof data.gameEntryUrl !== 'string' ||
    !Array.isArray(data.gamePluginModules)
  ) {
    throw new TypeError('Play execution bootstrap data is invalid');
  }
  return data as PlayExecutionBootstrapData;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isPlayExecutionEntityDiagnostics(
  value: unknown,
): value is PlayExecutionEntityDiagnostics {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entity = value as Partial<PlayExecutionEntityDiagnostics>;
  const meshFilter = entity.meshFilter;
  const meshRenderer = entity.meshRenderer;
  const childOf = entity.childOf;
  return isSafeNonNegativeInteger(entity.entity)
    && Array.isArray(entity.components)
    && entity.components.every((component) => typeof component === 'string')
    && (entity.name === undefined || typeof entity.name === 'string')
    && (meshFilter === undefined
      || (typeof meshFilter === 'object'
        && meshFilter !== null
        && !Array.isArray(meshFilter)
        && typeof meshFilter.hasAsset === 'boolean'))
    && (meshRenderer === undefined
      || (typeof meshRenderer === 'object'
        && meshRenderer !== null
        && !Array.isArray(meshRenderer)
        && isSafeNonNegativeInteger(meshRenderer.materialCount)))
    && (childOf === undefined
      || (typeof childOf === 'object'
        && childOf !== null
        && !Array.isArray(childOf)
        && isSafeNonNegativeInteger(childOf.parent)));
}

export function isPlayExecutionRealmMessage(value: unknown): value is PlayExecutionRealmMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Partial<PlayExecutionRealmMessage>;
  if (message.protocol !== PLAY_EXECUTION_PROTOCOL) return false;
  if (message.kind === 'realm-ready') {
    return isPlayRendererProvenance(message.renderer);
  }
  if (message.kind === 'heartbeat') {
    return typeof message.fps === 'number'
      && Number.isFinite(message.fps)
      && message.fps >= 0
      && typeof message.sentinel === 'number'
      && Number.isSafeInteger(message.sentinel)
      && message.sentinel >= 0;
  }
  if (message.kind !== 'runtime-diagnostics') return false;
  const diagnostics = message.diagnostics as Partial<PlayExecutionRuntimeDiagnostics> | undefined;
  return diagnostics !== undefined
    && typeof diagnostics.entityCount === 'number'
    && Number.isSafeInteger(diagnostics.entityCount)
    && diagnostics.entityCount >= 0
    && Array.isArray(diagnostics.activeComponents)
    && diagnostics.activeComponents.every((component) => typeof component === 'string')
    && Array.isArray(diagnostics.entities)
    && diagnostics.entities.every((entity) => isPlayExecutionEntityDiagnostics(entity))
    && typeof diagnostics.vfxRuntimePresent === 'boolean'
    && typeof diagnostics.queuedIntents === 'number'
    && Number.isSafeInteger(diagnostics.queuedIntents)
    && Array.isArray(diagnostics.runtimeDiagnostics)
    && (diagnostics.featurePass === undefined || typeof diagnostics.featurePass === 'string')
    && (diagnostics.featureStatus === undefined || typeof diagnostics.featureStatus === 'string');
}

/** Minimal projection context used by diagnostics and contract tests. */
export interface PlayExecutionRealmContext {
  readonly world: World;
  readonly renderer: Renderer;
}
