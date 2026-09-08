import type { VersionControlSnapshot } from '@forgeax/editor-core';
import type { VersionControlProvider } from './provider';

export interface VersionControlSnapshotProjection {
  readonly generation: number;
  readonly read: () => VersionControlSnapshot;
  readonly refresh: () => Promise<VersionControlSnapshot>;
  readonly clear: () => void;
}

/** Runtime-owned read projection; it never executes Git or creates a second catalog. */
export function createVersionControlSnapshotProjection(
  provider: VersionControlProvider,
): VersionControlSnapshotProjection {
  return Object.freeze({
    generation: provider.generation,
    read: provider.snapshot,
    refresh: provider.refresh,
    clear: provider.clear,
  });
}

export function isVersionControlProjectionCurrent(
  projection: VersionControlSnapshotProjection,
  snapshot: VersionControlSnapshot,
): boolean {
  return snapshot.generation === projection.generation;
}
