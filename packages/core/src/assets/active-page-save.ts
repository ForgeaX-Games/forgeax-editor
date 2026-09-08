// active-page-save — host-layer Ctrl+S diversion registry (M4/B3).
//
// edit-runtime's keyboard-router-deps cannot import page Host APIs. The page
// extension registers a handler that saves the active MI PageController when
// appropriate; Level / other pages fall through to saveDocToDisk.

type ActivePageSaveHandler = () => boolean;

// Stack, not a single slot — mirrors configureEditorPageNavigation. StrictMode,
// Vite HMR and overlapping AppHost setup/teardown can register a stale handler
// after the live one; with one slot the stale cleanup then leaves Ctrl+S with no
// handler for the rest of the session.
const handlers: ActivePageSaveHandler[] = [];

function activeHandler(): ActivePageSaveHandler | undefined {
  return handlers[handlers.length - 1];
}

export function registerActivePageSaveHandler(next: ActivePageSaveHandler | null): () => void {
  if (next === null) {
    handlers.length = 0;
    return () => {};
  }
  handlers.push(next);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const at = handlers.lastIndexOf(next);
    if (at >= 0) handlers.splice(at, 1);
  };
}

/** Returns true when the active page handled save (caller must not saveDocToDisk). */
export function trySaveActivePage(): boolean {
  return activeHandler()?.() === true;
}
