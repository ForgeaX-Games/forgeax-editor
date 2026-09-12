/**
 * Shell-side scene read model when session ops run in the Viewport Runtime.
 * Local scene-list state in the iframe shell is not updated by Transport
 * dispatch; query the Runtime projection instead.
 */

import { useSyncExternalStore } from 'react';
import { EMPTY_SCENE_READ_MODEL, type SceneReadModel } from './scene-read-model';
import {
  getViewportRuntimeClientSnapshot,
  queryViewportRuntimeProjection,
  subscribeViewportRuntimeClient,
} from './viewport-runtime-client';

export type LocalSceneReadModelSource = {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => SceneReadModel;
};

let localSource: LocalSceneReadModelSource | null = null;
let remoteSceneReadModel: SceneReadModel | null = null;
const remoteListeners = new Set<() => void>();

/** Wire the in-process scene-list provider used when no Transport is bound. */
export function bindLocalSceneReadModelSource(source: LocalSceneReadModelSource): () => void {
  localSource = source;
  return () => {
    if (localSource === source) localSource = null;
  };
}

function publishRemote(next: SceneReadModel | null): void {
  remoteSceneReadModel = next;
  for (const listener of [...remoteListeners]) listener();
}

/** Pull the authoritative scene manifest from the Viewport Runtime. */
export async function refreshAuthoritativeSceneReadModel(): Promise<void> {
  if (getViewportRuntimeClientSnapshot().status !== 'ready') {
    if (remoteSceneReadModel !== null) publishRemote(null);
    return;
  }
  try {
    const envelope = await queryViewportRuntimeProjection<SceneReadModel>({ kind: 'scene.readModel' });
    if (envelope.status === 'ready' && envelope.value !== undefined) {
      publishRemote(envelope.value);
    }
  } catch {
    // Transient disconnect — keep the last good snapshot.
  }
}

function subscribeAuthoritativeSceneReadModel(listener: () => void): () => void {
  remoteListeners.add(listener);
  void refreshAuthoritativeSceneReadModel();
  const unsubLocal = localSource?.subscribe(listener);
  const unsubViewport = subscribeViewportRuntimeClient(() => {
    void refreshAuthoritativeSceneReadModel();
  });
  return () => {
    remoteListeners.delete(listener);
    unsubLocal?.();
    unsubViewport();
  };
}

function getAuthoritativeSceneReadModelSnapshot(): SceneReadModel {
  if (getViewportRuntimeClientSnapshot().status === 'ready' && remoteSceneReadModel !== null) {
    return remoteSceneReadModel;
  }
  return localSource?.getSnapshot() ?? EMPTY_SCENE_READ_MODEL;
}

/** Scene manifest for Shell UI — Runtime projection when Transport is bound. */
export function useAuthoritativeSceneReadModel(): SceneReadModel {
  return useSyncExternalStore(
    subscribeAuthoritativeSceneReadModel,
    getAuthoritativeSceneReadModelSnapshot,
    getAuthoritativeSceneReadModelSnapshot,
  );
}
