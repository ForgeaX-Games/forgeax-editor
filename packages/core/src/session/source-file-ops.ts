// source-file-ops — deleteSourceFile session applier (editor data-operation-
// view convergence M1).

import { registerApplier, type SessionApplier } from '../io/appliers';
import { assetIO } from '../io/asset-io-facade';
import { broadcastAssetsChanged } from '../store/assets-changed';
import { resolveGamePath } from '../util/path-resolver';
import type { EditorOp } from '../types';
import {
  markSourceFileDeleteFailed,
  markSourceFileDeletePending,
  markSourceFileDeleted,
  hasSourceFileDeleteStatus,
} from './source-file-delete-status';

type DeleteSourceFileCommand = Extract<EditorOp, { kind: 'deleteSourceFile' }>;

const deleteSourceFileApplier: SessionApplier = (rawOp) => {
  const op = rawOp as DeleteSourceFileCommand;
  if (typeof op.path !== 'string' || op.path.trim() === '') {
    return { ok: false as const, error: { code: 'INVALID_ARGS', hint: 'deleteSourceFile.path must be a non-empty game-relative path' } };
  }
  if (typeof op.requestId !== 'string' || op.requestId.trim() === '') {
    return { ok: false as const, error: { code: 'INVALID_ARGS', hint: 'deleteSourceFile.requestId must be a non-empty caller-minted id' } };
  }
  if (hasSourceFileDeleteStatus(op.requestId)) {
    return {
      ok: false as const,
      error: {
        code: 'INVALID_ARGS',
        hint: 'deleteSourceFile.requestId has already been accepted; mint a new id for a retry',
      },
    };
  }

  let resolvedPath: string;
  try {
    resolvedPath = resolveGamePath(op.path);
  } catch (err) {
    return {
      ok: false as const,
      error: {
        code: 'SOURCE_FILE_DELETE_FAILED',
        hint: `cannot resolve source file path ${op.path}: ${(err as Error)?.message ?? String(err)}`,
      },
    };
  }

  markSourceFileDeletePending(op.requestId, op.path);
  void assetIO.deleteSourceFile(resolvedPath).then((result) => {
    if (result.ok) {
      markSourceFileDeleted(op.requestId, op.path);
      broadcastAssetsChanged('pack-changed', 'local-op');
    } else {
      markSourceFileDeleteFailed(op.requestId, op.path, result.error);
    }
  });

  return { ok: true as const };
};

registerApplier('session', 'deleteSourceFile', deleteSourceFileApplier);
