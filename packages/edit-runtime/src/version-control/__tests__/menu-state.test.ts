import { describe, expect, it } from 'bun:test';
import type { VersionControlSnapshot } from '@forgeax/editor-core';
import { createVersionControlMenuModel } from '../menu-model';

const snapshots: readonly VersionControlSnapshot[] = [
  { generation: 1, status: 'unavailable', error: { code: 'version-control-unavailable', hint: 'Host unavailable' } as never },
  { generation: 1, status: 'uninitialized', error: { code: 'version-control-unavailable', hint: 'Repository is not initialized' } as never },
  { generation: 1, status: 'faulted', error: { code: 'version-control-unexpected', hint: 'Repository inspection failed' } as never },
  { generation: 1, status: 'running', run: { operationId: 'publishGameVersion', runId: 'run-1', requestId: 'request-1', status: 'running' } as never },
  { generation: 1, status: 'recovery-required', error: { code: 'version-control-recovery-required', hint: 'Recovery is required' } as never },
  {
    generation: 1,
    status: 'ready',
    repositoryIdentity: 'repo:/game',
    head: 'head-1',
    currentTag: 'playtest/a',
    snapshotId: 'snapshot-1',
    dirtyRecords: [],
    graph: { nodes: [], edges: [] },
  },
  {
    generation: 1,
    status: 'ready',
    repositoryIdentity: 'repo:/game',
    head: 'head-2',
    currentTag: null,
    snapshotId: 'snapshot-2',
    dirtyRecords: [{ path: 'scene.pack', kind: 'modified' }],
    graph: { nodes: [], edges: [] },
  },
];

describe('version control fixed menu', () => {
  it('keeps the popover closed until the footer entry is activated', () => {
    expect(createVersionControlMenuModel(snapshots[0]!).open).toBe(false);
  });

  it('keeps settings, publish, and switch visible for every snapshot state', () => {
    for (const snapshot of snapshots) {
      const model = createVersionControlMenuModel(snapshot);
      expect(model.entryId).toBe('version-control');
      expect(model.actions.map((action) => action.id)).toEqual([
        'settings',
        'publish-version',
        'switch-version',
      ]);
      expect(model.summary.length).toBeGreaterThan(0);
      expect(model.reason.length).toBeGreaterThan(0);
    }
  });

  it('derives enablement from structured snapshot fields rather than error text', () => {
    const unavailable = createVersionControlMenuModel(snapshots[0]!);
    const ready = createVersionControlMenuModel(snapshots[5]!);
    const dirty = createVersionControlMenuModel(snapshots[6]!);
    const running = createVersionControlMenuModel(snapshots[3]!);
    expect(unavailable.actions.find((action) => action.id === 'publish-version')?.enabled).toBe(true);
    expect(ready.actions.find((action) => action.id === 'publish-version')?.enabled).toBe(true);
    expect(ready.actions.find((action) => action.id === 'publish-version')?.reason).toContain('Refresh');
    expect(dirty.actions.find((action) => action.id === 'publish-version')?.enabled).toBe(true);
    expect(unavailable.actions.find((action) => action.id === 'switch-version')?.enabled).toBe(true);
    expect(ready.actions.find((action) => action.id === 'switch-version')?.enabled).toBe(true);
    expect(dirty.actions.find((action) => action.id === 'switch-version')?.enabled).toBe(true);
    expect(dirty.actions.find((action) => action.id === 'switch-version')?.reason).toContain('Publish or save');
    expect(running.actions.every((action) => action.enabled === false)).toBe(true);
  });
});
