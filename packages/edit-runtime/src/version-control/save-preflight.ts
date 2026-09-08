import type { OperationRun } from '@forgeax/editor-product';

export interface SavePreflightSnapshot {
  readonly repositoryIdentity: string;
  readonly head: string | null;
  readonly snapshotId: string;
  readonly dirtyRecords: readonly unknown[];
}

export type SavePreflightResult =
  | { readonly ok: true; readonly snapshot: SavePreflightSnapshot }
  | { readonly ok: false; readonly error: { readonly code: string; readonly hint: string; readonly expected?: unknown; readonly actual?: unknown; readonly recoveryActions: readonly string[] } };

export async function createSavePreflight(input: {
  readonly saveRun: OperationRun;
  readonly expectedSnapshotId: string;
  readonly readSnapshot: () => Promise<SavePreflightSnapshot>;
}): Promise<SavePreflightResult> {
  if (input.saveRun.status !== 'succeeded') {
    return {
      ok: false,
      error: {
        code: input.saveRun.status === 'failed' ? 'save-write-failed' : 'save-not-terminal',
        hint: input.saveRun.status === 'failed' ? 'Save did not reach terminal success.' : 'Wait for save to reach terminal success before reading Git status.',
        recoveryActions: ['run.wait', 'run.retry'],
      },
    };
  }
  const snapshot = await input.readSnapshot();
  if (snapshot.snapshotId !== input.expectedSnapshotId) {
    return {
      ok: false,
      error: {
        code: 'version-control-snapshot-stale',
        hint: 'The repository changed after the save completed; refresh before publishing.',
        expected: input.expectedSnapshotId,
        actual: snapshot.snapshotId,
        recoveryActions: ['version-control.refresh', 'run.retry'],
      },
    };
  }
  return { ok: true, snapshot };
}
