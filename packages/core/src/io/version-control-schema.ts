import type { CommandError } from '../types';
import type { OperationRun } from './operation-runs';
import type { ArgsSchema, OperationRunDescriptor } from './catalog';

export const VERSION_CONTROL_OPERATION_IDS = Object.freeze([
  'configureGitExecutable',
  'initializeGameRepository',
  'publishGameVersion',
  'switchGameVersion',
] as const);
/** Stable camelCase session operation ids shared by Human and AI callers. */
export type VersionControlOperationId = typeof VERSION_CONTROL_OPERATION_IDS[number];

export const VERSION_CONTROL_ERROR_CODES = Object.freeze([
  'version-control-unavailable',
  'version-control-root-mismatch',
  'version-control-tag-conflict',
  'version-control-request-conflict',
  'version-control-snapshot-stale',
  'version-control-target-stale',
  'version-control-partial-publish',
  'version-control-worktree-dirty',
  'version-control-operation-busy',
  'version-control-transition-active',
  'version-control-staging-active',
  'version-control-external-inspection-required',
  'version-control-checkout-failed',
  'version-control-recovery-required',
  'version-control-command-failed',
  'version-control-unexpected',
 ] as const);
export type VersionControlErrorCode = typeof VERSION_CONTROL_ERROR_CODES[number];

export interface VersionControlDirtyRecord {
  readonly path: string;
  readonly kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'type-changed' | 'conflicted';
  readonly oldPath?: string;
  readonly binary?: boolean;
}

export interface VersionControlGraph {
  readonly nodes: readonly {
    readonly id: string;
    readonly tag?: string;
    readonly tags?: readonly string[];
    readonly latest?: boolean;
    readonly head: string;
    /** Commit subject; absent only for projections produced by older Hosts. */
    readonly message?: string;
    /** Git committer time in epoch seconds for newest-first ordering. */
    readonly committedAt?: number;
  }[];
  readonly edges: readonly { readonly from: string; readonly to: string }[];
}

export type VersionControlSnapshotStatus =
  | {
    readonly generation: number;
    readonly status: 'unavailable' | 'uninitialized' | 'faulted';
    readonly error: CommandError;
  }
  | {
    readonly generation: number;
    readonly status: 'running';
    readonly run: OperationRun;
  }
  | {
    readonly generation: number;
    readonly status: 'recovery-required';
    readonly error: CommandError;
  }
  | {
    readonly generation: number;
    readonly status: 'ready';
    readonly repositoryIdentity: string;
    readonly head: string | null;
    readonly currentTag: string | null;
    readonly snapshotId: string;
    readonly dirtyRecords: readonly VersionControlDirtyRecord[];
    readonly graph: VersionControlGraph;
    readonly running?: OperationRun;
  };

export type VersionControlSnapshot = VersionControlSnapshotStatus;
/** Read-only Runtime projection; every variant is fenced to one generation. */
export interface VersionControlSnapshotEnvelope {
  readonly generation: number;
  readonly snapshot: VersionControlSnapshot;
}

/** Public args, confirmation, retry, and terminal contract for one operation. */
export interface VersionControlOperationDescriptor {
  readonly id: VersionControlOperationId;
  readonly domain: 'session';
  readonly argsSchema: ArgsSchema;
  readonly confirmation: { readonly required: true; readonly reason: string };
  readonly operationRun: OperationRunDescriptor;
  readonly recoveryActions: readonly string[];
}

export function createVersionControlSnapshotEnvelope(snapshot: VersionControlSnapshot): VersionControlSnapshotEnvelope {
  return Object.freeze({ generation: snapshot.generation, snapshot });
}

export function isVersionControlSnapshotForGeneration(
  snapshot: VersionControlSnapshot,
  generation: number,
): boolean {
  return snapshot.generation === generation;
}

export function isVersionControlOperationId(value: string): value is VersionControlOperationId {
  return (VERSION_CONTROL_OPERATION_IDS as readonly string[]).includes(value);
}
