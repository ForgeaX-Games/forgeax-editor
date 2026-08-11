import type {
  ExecutionBootstrapEntry,
  ExecutionBootstrapValue,
  ExecutionRealmBootstrapContext,
} from '@forgeax/engine-app';

export const PLAY_EXECUTION_PROTOCOL = 'forgeax.play-execution/v1' as const;

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
  readonly vfxRuntimePresent: boolean;
  readonly queuedIntents: number;
  readonly runtimeDiagnostics: readonly ExecutionBootstrapValue[];
  readonly featurePass?: string;
  readonly featureStatus?: string;
  readonly featureError?: ExecutionBootstrapValue;
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
      readonly rendererIdentity: string;
      readonly rendererGeneration: number;
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
  readonly default: ExecutionBootstrapEntry;
  readonly host?: PlayExecutionHostEntry;
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

export function isPlayExecutionRealmMessage(value: unknown): value is PlayExecutionRealmMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Partial<PlayExecutionRealmMessage>;
  if (message.protocol !== PLAY_EXECUTION_PROTOCOL) return false;
  if (message.kind === 'realm-ready') {
    return typeof message.rendererIdentity === 'string'
      && typeof message.rendererGeneration === 'number'
      && Number.isSafeInteger(message.rendererGeneration)
      && message.rendererGeneration >= 0;
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
    && typeof diagnostics.vfxRuntimePresent === 'boolean'
    && typeof diagnostics.queuedIntents === 'number'
    && Number.isSafeInteger(diagnostics.queuedIntents)
    && Array.isArray(diagnostics.runtimeDiagnostics)
    && (diagnostics.featurePass === undefined || typeof diagnostics.featurePass === 'string')
    && (diagnostics.featureStatus === undefined || typeof diagnostics.featureStatus === 'string');
}

export type PlayExecutionRealmContext = ExecutionRealmBootstrapContext;
