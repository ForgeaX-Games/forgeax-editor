import type { CommandError } from '../types';
import {
  projectGeneratedSceneOverrides,
  type GeneratedSceneOverride,
  type GeneratedSceneOverrideState,
} from './spawn-asset-ref';
import type { EntityHandle } from './scene-types';
import type { ScenePublicationFence } from '@forgeax/engine-assets-runtime';

export interface GeneratedSceneWrapperSnapshot {
  readonly root: EntityHandle;
  /** The current derived SceneInstance child owned by this wrapper. */
  readonly derivedRoot?: EntityHandle;
  readonly parent: EntityHandle | null;
  readonly transform: unknown;
  readonly sourcePath: string;
  readonly sourceKey: string;
  readonly generation: number;
  readonly publicationFence?: ScenePublicationFence;
}

export interface GeneratedSceneStagedTree {
  readonly token: string;
  /** The staged derived SceneInstance root, when the host uses the native
   * SceneAsset instantiation spine. */
  readonly derivedRoot?: EntityHandle;
  readonly members: readonly EntityHandle[];
  /** Old member handle → replacement member handle, keyed by engine identity. */
  readonly memberMap?: ReadonlyMap<EntityHandle, EntityHandle>;
  readonly state: GeneratedSceneOverrideState;
  readonly diagnostics?: readonly unknown[];
}

export interface GeneratedSceneRefreshRequest {
  readonly wrapper: EntityHandle;
  readonly sourcePath: string;
  readonly sourceKey: string;
  readonly generation: number;
  readonly publicationFence?: ScenePublicationFence;
  readonly overrides: readonly GeneratedSceneOverride[];
}

export interface GeneratedSceneRefreshResult {
  readonly root: EntityHandle;
  readonly parent: EntityHandle | null;
  readonly transform: unknown;
  readonly members: readonly EntityHandle[];
  readonly generation: number;
  readonly publicationFence?: ScenePublicationFence;
  readonly appliedOverrides: readonly GeneratedSceneOverride[];
}

export interface GeneratedSceneRefreshHost {
  snapshotWrapper(root: EntityHandle, request?: GeneratedSceneRefreshRequest): GeneratedSceneWrapperSnapshot | undefined;
  stageTree(request: GeneratedSceneRefreshRequest): Promise<
    | { readonly ok: true; readonly value: GeneratedSceneStagedTree }
    | { readonly ok: false; readonly error: unknown }
  >;
  swapTree(input: {
    readonly snapshot: GeneratedSceneWrapperSnapshot;
    readonly staged: GeneratedSceneStagedTree;
    readonly overrides: readonly GeneratedSceneOverride[];
  }): { readonly ok: true } | { readonly ok: false; readonly error: unknown };
  discardTree?(staged: GeneratedSceneStagedTree): void;
}

export interface GeneratedSceneRefreshError extends CommandError {
  readonly code: 'generated-scene-refresh-failed';
  readonly phase: 'validation' | 'publication';
  readonly sourcePath: string;
  readonly sourceKey: string;
  readonly candidateGeneration: number;
  readonly currentGeneration?: number;
  readonly retryable: boolean;
  readonly recoveryActions: readonly string[];
}

export type GeneratedSceneRefreshOutcome =
  | { readonly ok: true; readonly value: GeneratedSceneRefreshResult }
  | { readonly ok: false; readonly error: GeneratedSceneRefreshError | CommandError };

function detail(value: unknown): unknown {
  return value instanceof Error ? value.message : value;
}

function refreshError(
  request: GeneratedSceneRefreshRequest,
  hint: string,
  error: unknown,
  phase: GeneratedSceneRefreshError['phase'],
  retryable: boolean,
  currentGeneration?: number,
): GeneratedSceneRefreshError {
  return {
    code: 'generated-scene-refresh-failed',
    hint,
    phase,
    sourcePath: request.sourcePath,
    sourceKey: request.sourceKey,
    candidateGeneration: request.generation,
    ...(currentGeneration === undefined ? {} : { currentGeneration }),
    retryable,
    recoveryActions: retryable
      ? ['asset-source.rebuild', 'asset.preflight', 'reopen-scene']
      : ['asset.preflight', 'revealInFileManager', 'promoteImportedScene', 'asset-source.clone'],
    details: detail(error),
  };
}

/**
 * Own generated Scene replacement at the wrapper boundary.
 *
 * The host stages a complete derived tree, then swaps it in one operation. The
 * authored wrapper, parent, Transform, and exact member overrides are never
 * reconstructed from a member diff, so a failed stage or validation leaves the
 * previous complete tree untouched.
 */
export function createGeneratedSceneRefreshOwner(host: GeneratedSceneRefreshHost): {
  refresh(request: GeneratedSceneRefreshRequest): Promise<GeneratedSceneRefreshOutcome>;
} {
  return {
    async refresh(request) {
      const snapshot = host.snapshotWrapper(request.wrapper, request);
      if (snapshot === undefined) {
        return {
          ok: false,
          error: refreshError(request, 'Generated Scene wrapper is not live.', 'wrapper-not-found', 'validation', false),
        };
      }
      const staged = await host.stageTree(request);
      if (!staged.ok) {
        return {
          ok: false,
          error: refreshError(request, 'Generated Scene publication could not be staged; the previous tree remains active.', staged.error, 'publication', true, snapshot.generation),
        };
      }
      const remappedOverrides = staged.value.memberMap === undefined
        ? request.overrides
        : request.overrides.map((override) => ({
          ...override,
          member: staged.value.memberMap?.get(override.member) ?? override.member,
        }));
      const projected = projectGeneratedSceneOverrides(remappedOverrides, staged.value.state, {
        sourcePath: request.sourcePath,
        sourceKey: request.sourceKey,
        generation: request.generation,
      });
      if (!projected.ok) {
        host.discardTree?.(staged.value);
        return { ok: false, error: projected.error };
      }
      const swapped = host.swapTree({ snapshot, staged: staged.value, overrides: projected.value });
      if (!swapped.ok) {
        host.discardTree?.(staged.value);
        return {
          ok: false,
          error: refreshError(request, 'Generated Scene replacement was rejected; the previous tree remains active.', swapped.error, 'publication', true, snapshot.generation),
        };
      }
      return {
        ok: true,
        value: {
          root: snapshot.root,
          parent: snapshot.parent,
          transform: snapshot.transform,
          members: staged.value.members,
          generation: request.generation,
          ...(request.publicationFence === undefined ? {} : { publicationFence: request.publicationFence }),
          appliedOverrides: projected.value,
        },
      };
    },
  };
}
