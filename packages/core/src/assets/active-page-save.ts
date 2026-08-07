// active-page-save — host-layer Ctrl+S diversion registry (M4/B3).
//
// edit-runtime's keyboard-router-deps cannot import page Host APIs. The page
// extension registers a handler that saves the active MI PageController when
// appropriate; Level / other pages fall through to saveDocToDisk.

type ActivePageSaveHandler = () => boolean;

let handler: ActivePageSaveHandler | null = null;

export function registerActivePageSaveHandler(next: ActivePageSaveHandler | null): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/** Returns true when the active page handled save (caller must not saveDocToDisk). */
export function trySaveActivePage(): boolean {
  return handler?.() === true;
}
