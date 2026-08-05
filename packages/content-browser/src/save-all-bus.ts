// save-all-bus — a tiny module-level request/resolve channel so the Content
// Browser toolbar / `contentBrowser.saveAll` command (which may run outside the
// React subtree that hosts the dialog) can surface a UE-style "Save Content"
// review dialog without coupling the trigger site to the portal host. Mirrors
// delete-guard-bus.ts exactly; the only difference is the (empty) request
// payload — the dialog reads the live session-dirty-asset set itself.
//
// Anchors:
//   UE-style "Save Content" dialog (plan §2): trigger calls requestSaveAll();
//   a mounted <ContentBrowser/> subscribes, opens <SaveAssetsDialog/>, and
//   resolves via resolveSaveAll() on confirm/cancel.

export interface SaveAllRequest {
  readonly id: number;
}

type Resolver = (ok: boolean) => void;

let nextId = 1;
let pending: { req: SaveAllRequest; resolve: Resolver } | null = null;
const listeners = new Set<(req: SaveAllRequest | null) => void>();

/** Ask the UI to run the "Save Content" review dialog. Resolves true if the
 *  user confirmed a save, false if they cancelled or there was nothing to save. */
export function requestSaveAll(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    pending = { req: { id: nextId++ }, resolve };
    for (const fn of listeners) fn(pending.req);
  });
}

/** Subscribe to save-all requests (null = dialog dismissed). Returns unsubscribe. */
export function subscribeSaveAllRequest(fn: (req: SaveAllRequest | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Resolve the pending request (called by the dialog's buttons). */
export function resolveSaveAll(ok: boolean): void {
  const p = pending;
  pending = null;
  for (const fn of listeners) fn(null);
  p?.resolve(ok);
}
