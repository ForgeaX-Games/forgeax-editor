import { ChildOf, Transform } from '@forgeax/engine-scene';
import type { World } from '@forgeax/engine-ecs';
import { resolveAssetHandle, type ScenePublicationFence } from '@forgeax/engine-assets-runtime';
import type { CatalogEntry } from '@forgeax/engine-types';
import { gateway } from '../store/store';
import { instantiateSceneRefUnderWorldDetailed } from '../store/scene-persistence';
import type { EntityHandle } from './scene-types';
import {
  createGeneratedSceneRefreshOwner,
  type GeneratedSceneRefreshHost,
  type GeneratedSceneRefreshRequest,
  type GeneratedSceneStagedTree,
  type GeneratedSceneWrapperSnapshot,
} from './generated-scene-refresh';
import { sceneInstanceRoots } from '../io/scene-instance-read-model';
import { scenePublicationFenceFromCatalog } from '@forgeax/engine-assets-runtime';
import type { GeneratedSceneOverride } from './spawn-asset-ref';

export interface GeneratedScenePublicationRefreshInput {
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly generation: number;
  readonly digest: string;
  readonly outputSetDigest: string;
  readonly outputGuids: readonly string[];
}

export interface GeneratedScenePublicationRefreshResult {
  readonly refreshed: number;
}

function childOf(world: NonNullable<typeof gateway.doc.world>, entity: EntityHandle): EntityHandle | null {
  const result = world.get(entity, ChildOf);
  if (!result.ok || result.value.parent === undefined) return null;
  return result.value.parent as EntityHandle;
}

function directSceneChild(world: NonNullable<typeof gateway.doc.world>, wrapper: EntityHandle): EntityHandle | undefined {
  const roots = new Set(sceneInstanceRoots(world));
  for (const entity of world.iterDescendants(wrapper)) {
    if (childOf(world, entity) === wrapper && roots.has(entity)) return entity;
  }
  return undefined;
}

function sourceGuidFor(root: EntityHandle): string | undefined {
  const world = gateway.doc.world;
  const registry = gateway.doc.registry;
  if (world === undefined || registry === undefined) return undefined;
  const state = gateway.engineFacade().getSceneInstanceState(root);
  if (!state.ok) return undefined;
  const source = resolveAssetHandle(world, state.value.source);
  return source.ok ? registry._guidForAsset(source.value) : undefined;
}

function catalogRowForGuid(guid: string, entries: readonly CatalogEntry[]): CatalogEntry | undefined {
  return entries.find((entry) => entry.guid.toLowerCase() === guid.toLowerCase());
}

function rowMatchesPublication(
  row: CatalogEntry,
  input: GeneratedScenePublicationRefreshInput,
): boolean {
  const publication = row.publication;
  return publication !== undefined
    && publication.sourcePath === input.sourcePath
    && publication.sourceRevision === input.sourceRevision
    && publication.generation === input.generation
    && publication.digest === input.digest
    && publication.outputSetDigest === input.outputSetDigest;
}

function rowMatchesFence(row: CatalogEntry, fence: ScenePublicationFence): boolean {
  const publication = row.publication;
  return publication !== undefined
    && publication.sourcePath === fence.sourcePath
    && publication.sourceRevision === fence.sourceRevision
    && publication.generation === fence.publicationGeneration
    && publication.digest === fence.outputDigest
    && publication.outputSetDigest === fence.outputSetDigest;
}

function liveCatalogEntries(): readonly CatalogEntry[] {
  return gateway.assetCatalog().flatMap((entry) =>
    typeof entry.sourcePath === 'string' ? [entry as CatalogEntry] : [],
  );
}

function componentFields(world: World, member: EntityHandle): ReadonlySet<string> {
  const fields = new Set<string>();
  for (const [name, token] of world.components.entries()) {
    const result = world.get(member, token);
    if (!result.ok || result.value === null || typeof result.value !== 'object') continue;
    for (const field of Object.keys(result.value as Record<string, unknown>)) {
      fields.add(`${member}:${name}:${field}`);
    }
  }
  return fields;
}

function host(): GeneratedSceneRefreshHost {
  const snapshotWrapper = (wrapper: EntityHandle, request?: GeneratedSceneRefreshRequest): GeneratedSceneWrapperSnapshot | undefined => {
    const world = gateway.doc.world;
    const registry = gateway.doc.registry;
    if (world === undefined || registry === undefined) return undefined;
    const derivedRoot = directSceneChild(world, wrapper);
    if (derivedRoot === undefined) return undefined;
    const sourceGuid = sourceGuidFor(derivedRoot);
    if (sourceGuid === undefined) return undefined;
    const entries = liveCatalogEntries();
    const row = catalogRowForGuid(sourceGuid, entries);
    if (request !== undefined && (
      row === undefined
      || row.sourcePath !== request.sourcePath
      || row.sourceKey !== request.sourceKey
      || (request.publicationFence !== undefined && !rowMatchesFence(row, request.publicationFence))
    )) return undefined;
    const transform = world.get(wrapper, Transform);
    const parent = childOf(world, wrapper);
    const fence = scenePublicationFenceFromCatalog(entries, sourceGuid);
    return {
      root: wrapper,
      derivedRoot,
      parent,
      transform: transform.ok ? transform.value : {},
      sourcePath: row?.sourcePath ?? request?.sourcePath ?? '',
      sourceKey: row?.sourceKey ?? request?.sourceKey ?? '',
      generation: row?.publication?.generation ?? request?.generation ?? 0,
      ...(fence.ok ? { publicationFence: fence.value } : {}),
    };
  };

  const stageTree = async (request: GeneratedSceneRefreshRequest): Promise<
    | { readonly ok: true; readonly value: GeneratedSceneStagedTree }
    | { readonly ok: false; readonly error: unknown }
  > => {
    const world = gateway.doc.world;
    const registry = gateway.doc.registry;
    if (world === undefined || registry === undefined) return { ok: false, error: 'editor world or asset registry is unavailable' };
    const entries = liveCatalogEntries();
    const row = entries.find((entry: CatalogEntry) =>
      entry.sourcePath === request.sourcePath
      && entry.sourceKey === request.sourceKey
      && entry.kind === 'scene'
      && entry.publication?.generation === request.generation
      && (request.publicationFence === undefined || rowMatchesFence(entry, request.publicationFence)),
    );
    if (row === undefined) return { ok: false, error: 'new Scene output is not present in the complete publication Catalog' };
    const oldRoot = directSceneChild(world, request.wrapper);
    const instantiated = await instantiateSceneRefUnderWorldDetailed(row.guid, request.wrapper as number);
    if (!instantiated.ok) return { ok: false, error: instantiated.error };
    const derivedRoot = instantiated.root as EntityHandle;
    const state = gateway.engineFacade().getSceneInstanceState(derivedRoot);
    if (!state.ok) return { ok: false, error: state.error };
    const oldState = oldRoot === undefined ? undefined : gateway.engineFacade().getSceneInstanceState(oldRoot);
    const memberMap = new Map<EntityHandle, EntityHandle>();
    if (oldState?.ok) {
      const replacementByLocalId = new Map<number, EntityHandle>();
      for (const [replacement, localId] of state.value.entityToLocalId) {
        replacementByLocalId.set(Number(localId), replacement);
      }
      for (const [oldMember, localId] of oldState.value.entityToLocalId) {
        const replacement = replacementByLocalId.get(Number(localId));
        if (replacement !== undefined) memberMap.set(oldMember, replacement);
      }
    }
    const members = [...state.value.entityToLocalId.keys()];
    const fields = new Set<string>();
    for (const member of members) for (const field of componentFields(world, member)) fields.add(field);
    return {
      ok: true,
      value: {
        token: `generated-scene-refresh:${String(derivedRoot)}:${Date.now()}`,
        derivedRoot,
        members,
        memberMap,
        state: { members: new Set(members), fields },
      },
    };
  };

  const swapTree = (input: {
    readonly snapshot: GeneratedSceneWrapperSnapshot;
    readonly staged: GeneratedSceneStagedTree;
    readonly overrides: readonly GeneratedSceneOverride[];
  }): { readonly ok: true } | { readonly ok: false; readonly error: unknown } => {
    const world = gateway.doc.world;
    if (world === undefined || input.staged.derivedRoot === undefined) return { ok: false, error: 'staged Scene root is unavailable' };
    const engine = gateway.engineFacade();
    for (const override of input.overrides) {
      const token = world.components.resolve(override.component);
      if (token === undefined) return { ok: false, error: `unknown override component ${override.component}` };
      const applied = engine.setSceneOverride(
        input.staged.derivedRoot,
        override.member,
        token as never,
        override.field,
        override.value,
      );
      if (!applied.ok) return { ok: false, error: applied.error };
    }
    if (input.snapshot.derivedRoot !== undefined && input.snapshot.derivedRoot !== input.staged.derivedRoot) {
      const removed = engine.despawnScene(input.snapshot.derivedRoot);
      if (!removed.ok) {
        engine.despawnScene(input.staged.derivedRoot);
        return { ok: false, error: removed.error };
      }
    }
    return { ok: true };
  };

  return {
    snapshotWrapper,
    stageTree,
    swapTree,
    discardTree: (staged) => {
      if (staged.derivedRoot !== undefined) gateway.engineFacade().despawnScene(staged.derivedRoot);
    },
  };
}

/** Refresh mounted generated Scene instances after one complete publication.
 * The authored wrapper remains the identity boundary; only its derived
 * SceneInstance child is staged, override-replayed, and atomically swapped. */
export async function refreshGeneratedSceneInstances(
  input: GeneratedScenePublicationRefreshInput,
): Promise<GeneratedScenePublicationRefreshResult> {
  const world = gateway.doc.world;
  const registry = gateway.doc.registry;
  if (world === undefined || registry === undefined) return { refreshed: 0 };
  const entries = liveCatalogEntries();
  const sceneRows = entries.filter((entry: CatalogEntry) =>
    entry.kind === 'scene'
    && entry.sourcePath === input.sourcePath
    && rowMatchesPublication(entry, input),
  );
  if (sceneRows.length === 0) return { refreshed: 0 };
  const candidateGuids = new Set(sceneRows.map((row: CatalogEntry) => row.guid.toLowerCase()));
  const owner = createGeneratedSceneRefreshOwner(host());
  let refreshed = 0;
  for (const root of sceneInstanceRoots(world)) {
    const guid = sourceGuidFor(root);
    if (guid === undefined || !candidateGuids.has(guid.toLowerCase())) continue;
    const wrapper = childOf(world, root);
    if (wrapper === null) continue;
    const model = gateway.sceneInstanceReadModel(root);
    if (!model.ok) continue;
    const row = catalogRowForGuid(guid, sceneRows);
    if (row === undefined || row.sourceKey === undefined) continue;
    const fence = scenePublicationFenceFromCatalog(entries, guid);
    if (!fence.ok) throw fence.error;
    const overrides: GeneratedSceneOverride[] = [];
    for (const override of model.value.overrides) {
      if (override.field === undefined) {
        throw new Error(`generated Scene override ${override.component} has no field and cannot be replayed safely`);
      }
      overrides.push({ member: override.member, component: override.component, field: override.field, value: override.value });
    }
    const result = await owner.refresh({
      wrapper,
      sourcePath: input.sourcePath,
      sourceKey: row.sourceKey,
      generation: input.generation,
      publicationFence: fence.value as ScenePublicationFence,
      overrides,
    });
    if (!result.ok) throw result.error;
    refreshed += 1;
  }
  return { refreshed };
}
