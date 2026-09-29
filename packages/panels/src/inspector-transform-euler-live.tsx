import { useRef, useSyncExternalStore } from 'react';
import {
  mountTransformEulerLiveSelector,
  entComponent,
  getActiveRuntimeUiGraph,
  type EntityHandle,
  type HandleCheckOpts,
  type TransformEulerDegrees,
} from '@forgeax/editor-core';

function quatAxis(raw: unknown, index: number, fallback: number): number {
  const v = (raw as ArrayLike<number> | undefined)?.[index];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function readTransformQuat(
  world: unknown,
  entity: EntityHandle,
  readOpts: HandleCheckOpts | undefined,
): readonly [number, number, number, number] {
  const result = entComponent(world as Parameters<typeof entComponent>[0], entity, 'Transform', readOpts);
  if (!result.ok) throw new Error(result.error.code);
  const raw = (result.value as Record<string, unknown>).quat;
  return [
    quatAxis(raw, 0, 0),
    quatAxis(raw, 1, 0),
    quatAxis(raw, 2, 0),
    quatAxis(raw, 3, 1),
  ];
}

/** One graph selector → one quatToEuler per publish (inspector-transform-live-sync §6 B). */
export function useTransformEulerLiveDegrees(
  entity: EntityHandle,
  fallback: TransformEulerDegrees,
  readOpts: HandleCheckOpts | undefined,
): TransformEulerDegrees {
  const graph = getActiveRuntimeUiGraph();
  const worldGeneration = graph?.stats().worldGeneration ?? 0;
  const readOptsRef = useRef(readOpts);
  readOptsRef.current = readOpts;
  const holder = useRef<{
    graph: NonNullable<ReturnType<typeof getActiveRuntimeUiGraph>>;
    key: string;
    mounted: ReturnType<ReturnType<typeof mountTransformEulerLiveSelector>['mount']>;
  } | null>(null);
  const key = `${entity}:${worldGeneration}`;
  if (graph !== null && (holder.current?.graph !== graph || holder.current.key !== key)) {
    holder.current?.mounted.unsubscribe();
    const selector = mountTransformEulerLiveSelector(graph, {
      entity,
      readQuat: (world, ent) => readTransformQuat(world, ent as EntityHandle, readOptsRef.current),
    });
    holder.current = { graph, key, mounted: selector.mount() };
  }
  const subscribe = (listener: () => void) => holder.current?.mounted.subscribe(listener) ?? (() => undefined);
  const getSnapshot = (): TransformEulerDegrees => {
    const snapshot = holder.current?.mounted.getSnapshot();
    if (snapshot?.status !== 'available') return fallback;
    return snapshot.value;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
