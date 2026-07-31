// source-file-ops — deleteSourceFile session applier and OperationRun completion.

import { registerApplier, type SessionApplier } from '../io/appliers';
import { assetIO } from '../io/asset-io-facade';
import { broadcastAssetsChanged } from '../store/assets-changed';
import { resolveGamePath } from '../util/path-resolver';
import type { EditorOp } from '../types';

// The async continuation remains an IO implementation detail. Product callers
// should use the OperationRun query; source-file-delete-status is compatibility
// display data and never decides whether the operation completed.

type DeleteSourceFileCommand = Extract<EditorOp, { kind: 'deleteSourceFile' }>;

const deleteSourceFileApplier: SessionApplier = (rawOp) => {
  const op = rawOp as DeleteSourceFileCommand;
  if (typeof op.path !== 'string' || op.path.trim() === '') {
    return { ok: false as const, error: { code: 'INVALID_ARGS', hint: 'deleteSourceFile.path must be a non-empty game-relative path' } };
  }
  if (typeof op.requestId !== 'string' || op.requestId.trim() === '') {
    return { ok: false as const, error: { code: 'INVALID_ARGS', hint: 'deleteSourceFile.requestId must be a non-empty caller-minted id' } };
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

  const completion = assetIO.deleteSourceFile(resolvedPath).then((result) => {
    if (result.ok) {
      broadcastAssetsChanged('pack-changed', 'local-op');
      return { ok: true as const, result: { path: op.path } };
    }
    return result;
  });

  return { ok: true as const, completion };
};

registerApplier('session', 'deleteSourceFile', deleteSourceFileApplier);
