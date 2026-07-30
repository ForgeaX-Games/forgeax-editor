import { useMemo } from 'react';
import type { AssetBrowserSnapshot, AssetWorkspaceSnapshot } from '@forgeax/editor-core';

const EMPTY_WORKSPACE: AssetWorkspaceSnapshot = Object.freeze({
  schemaVersion: 'asset-workspace/v1',
  revision: 'workspace:r0',
  resourceRevision: 'resource:r0',
  identity: 'workspace-snapshot:empty',
  subjects: Object.freeze([]),
  relations: Object.freeze([]),
  issues: Object.freeze([]),
});

/** The browser consumes the core workspace projection as a read-only value. */
export function projectWorkspaceSnapshot(snapshot: AssetWorkspaceSnapshot): AssetWorkspaceSnapshot {
  return snapshot;
}

/** Common product facts shared by the browser projection and headless callers. */
export function projectWorkspaceFacts(snapshot: AssetWorkspaceSnapshot): AssetWorkspaceSnapshot {
  return projectWorkspaceSnapshot(snapshot);
}

export function workspaceSnapshotFromBrowserSnapshot(
  snapshot: AssetBrowserSnapshot,
): AssetWorkspaceSnapshot {
  return snapshot.workspace ?? EMPTY_WORKSPACE;
}

export function useWorkspaceSnapshot(snapshot: AssetBrowserSnapshot): AssetWorkspaceSnapshot {
  return useMemo(() => projectWorkspaceFacts(workspaceSnapshotFromBrowserSnapshot(snapshot)), [snapshot]);
}
