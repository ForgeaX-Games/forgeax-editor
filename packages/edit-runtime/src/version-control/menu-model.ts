import type { VersionControlSnapshot } from '@forgeax/editor-core';

export type VersionControlMenuActionId = 'settings' | 'publish-version' | 'switch-version';

export interface VersionControlMenuAction {
  readonly id: VersionControlMenuActionId;
  readonly label: string;
  readonly enabled: boolean;
  readonly reason: string;
}

export interface VersionControlMenuModel {
  readonly entryId: 'version-control';
  readonly open: false;
  readonly summary: string;
  readonly reason: string;
  readonly actions: readonly VersionControlMenuAction[];
}

function stateReason(snapshot: VersionControlSnapshot): string {
  if (snapshot.status === 'ready') {
    if (snapshot.dirtyRecords.length > 0) return `${snapshot.dirtyRecords.length} change(s) are ready to publish.`;
    if (snapshot.currentTag === null) return 'Clean repository with no current game tag.';
    return `Current game tag: ${snapshot.currentTag}.`;
  }
  if (snapshot.status === 'running') return 'A version control operation is running.';
  return snapshot.error.hint;
}

export function createVersionControlMenuModel(snapshot: VersionControlSnapshot): VersionControlMenuModel {
  const ready = snapshot.status === 'ready';
  const dirty = ready && snapshot.dirtyRecords.length > 0;
  const clean = ready && !dirty;
  const running = snapshot.status === 'running';
  const reason = stateReason(snapshot);
  // Keep both repository actions pressable until the click path has read the
  // current Host snapshot. The status-bar projection is intentionally not a
  // synchronously refreshed capability gate.
  const enabled = !running;
  const publishEnabled = !running;
  return {
    entryId: 'version-control',
    open: false,
    summary: snapshot.status === 'ready' ? (dirty ? 'Game repository has changes' : 'Clean game repository') : snapshot.status,
    reason,
    actions: [
      { id: 'settings', label: 'Settings', enabled: !running, reason: running ? reason : 'Configure Git or initialize the game repository.' },
      {
        id: 'publish-version',
        label: 'Publish version',
        // Keep Publish actionable whenever no operation is running. The last
        // snapshot may be stale; the click path performs a fresh Host read
        // before opening the publish form.
        enabled: publishEnabled,
        reason: dirty
          ? 'Review changed files and publish a new game tag.'
          : (ready ? 'Refresh repository status and check for changed files.' : reason),
      },
      {
        id: 'switch-version',
        label: 'Switch version',
        enabled,
        reason: clean
          ? (snapshot.graph.nodes.length > 0 ? 'Switch to a reachable game tag or the latest untagged commit.' : 'No tagged or latest commit is available.')
          : (ready && dirty ? 'Publish or save all files before switching versions.' : reason),
      },
    ],
  };
}
