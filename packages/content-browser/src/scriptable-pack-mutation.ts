import {
  dispatchAndWaitActiveEditorOperation,
  gateway,
  type CommandError,
} from '@forgeax/editor-core';

/** Engine CAS revisions are bare lower-case SHA-256 digests. */
export function isCanonicalScriptablePackRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Read the source revision through the Gateway preflight operation. Publication
 * metadata uses a prefixed digest, but source mutation CAS uses the bare digest
 * returned by this operation only.
 */
export type ScriptablePackRevisionResult =
  | { readonly ok: true; readonly revision: string }
  | { readonly ok: false; readonly error: CommandError };

export async function readCanonicalScriptablePackRevision(
  sourcePath: string,
  outputGuid?: string,
  origin: 'human' | 'ai' = 'human',
): Promise<ScriptablePackRevisionResult> {
  const row = gateway.assetCatalog().find((candidate) => outputGuid !== undefined
    ? candidate.guid.toLowerCase() === outputGuid.toLowerCase()
    : candidate.sourcePath === sourcePath);
  const guid = outputGuid ?? row?.guid;
  if (guid === undefined) {
    return {
      ok: false,
      error: {
        code: 'asset-source-key-missing',
        hint: `No Catalog output GUID is available for asset source "${sourcePath}".`,
        retryable: false,
        recoveryActions: ['catalog.reconcile'],
      },
    };
  }
  const requestId = crypto.randomUUID();
  const result = await dispatchAndWaitActiveEditorOperation({
    kind: 'asset.preflight',
    guid,
    scope: row?.sourceKey === undefined ? { all: true } : { sourceKey: row.sourceKey },
    requestId,
  }, origin);
  if (!result.ok) return result;
  const revision = (result.result as { readonly revision?: unknown } | undefined)?.revision;
  if (isCanonicalScriptablePackRevision(revision)) return { ok: true, revision };
  return {
    ok: false,
    error: {
      code: 'operation-failed',
      hint: `Asset source preflight returned an invalid source revision for "${sourcePath}".`,
      retryable: false,
      recoveryActions: ['asset.preflight'],
    },
  };
}
