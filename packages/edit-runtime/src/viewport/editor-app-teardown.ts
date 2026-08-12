export interface EditorAppTeardownDeps {
  readonly unregisterErrorListener: () => void;
  readonly disposeSession: () => void;
  readonly stopApp: () => void;
  readonly removeCanvas: () => void;
}

export function createPagehideTeardown(
  teardown: () => void,
): (event: Pick<PageTransitionEvent, 'persisted'>) => void {
  let completed = false;
  return (event) => {
    if (event.persisted || completed) return;
    completed = true;
    teardown();
  };
}

/** Close an App whose asynchronous boot lost its lease before the next step. */
export function teardownIfStale(
  isCurrentBoot: () => boolean,
  teardown: () => void,
): boolean {
  if (isCurrentBoot()) return false;
  teardown();
  return true;
}

/** Close the editor realm in the only safe order. */
export function createEditorAppTeardown(deps: EditorAppTeardownDeps): () => void {
  let completed = false;
  return () => {
    if (completed) return;
    completed = true;
    try { deps.unregisterErrorListener(); } catch { /* already detached */ }
    try { deps.disposeSession(); } catch { /* stale session is already unwinding */ }
    try { deps.stopApp(); } catch { /* stale app is already unwinding */ }
    try { deps.removeCanvas(); } catch { /* already detached */ }
  };
}
