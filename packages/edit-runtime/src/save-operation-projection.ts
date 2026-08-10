// Human and AI save-entry projection.
//
// The toolbar and keyboard router mint the same Gateway operation payload. The
// run/dirty view is derived from canonical run facts plus the existing dirty
// read model; this module owns no completion flag or transport state.

import type { EditorOp } from '@forgeax/editor-core';
import { projectSaveRun, type SaveRunProjection } from '@forgeax/editor-panels/operation-projection';
import type { CommandError, OperationRun } from '@forgeax/editor-product';

export function createHumanSaveRequest(): Extract<EditorOp, { readonly kind: 'saveDocToDisk' }> {
  return { kind: 'saveDocToDisk', requestId: globalThis.crypto.randomUUID() };
}

export function projectSaveEntry(input: {
  readonly run?: OperationRun;
  readonly dirty: boolean;
  readonly error?: CommandError;
}): SaveRunProjection {
  return projectSaveRun(input);
}
