// delete-guard-bus — a tiny module-level request/resolve channel so the
// keyboard router's asset-delete path (which runs outside the React tree, in
// main.tsx DI) can surface a UI-layer confirmation dialog without editor-core
// leaving headless. The router deps call requestDeleteGuard(...); a mounted
// <DeleteGuardDialogHost/> resolves it via the shared <DeleteGuardDialog/>.
//
// Anchors:
//   M4 T4-3 / AC-C2: DeleteGuardDialog lives in the UI layer; core stays
//     headless (no dialog/confirm in appliers). Cross-reference warning is the
//     gate that decides whether a human confirm is needed.

export interface DeleteGuardAsset {
  guid: string;
  name: string;
  packPath: string;
}

export interface DeleteGuardRequest {
  assets: DeleteGuardAsset[];
}

type Resolver = (ok: boolean) => void;

let pending: { req: DeleteGuardRequest; resolve: Resolver } | null = null;
const listeners = new Set<(req: DeleteGuardRequest | null) => void>();

/** Ask the UI to confirm an asset delete. Resolves true if the user allows. */
export function requestDeleteGuard(req: DeleteGuardRequest): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    pending = { req, resolve };
    for (const fn of listeners) fn(req);
  });
}

/** Subscribe to guard requests (null = dialog dismissed). Returns unsubscribe. */
export function subscribeDeleteGuard(fn: (req: DeleteGuardRequest | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Resolve the pending request (called by the dialog's buttons). */
export function resolveDeleteGuard(ok: boolean): void {
  const p = pending;
  pending = null;
  for (const fn of listeners) fn(null);
  p?.resolve(ok);
}
