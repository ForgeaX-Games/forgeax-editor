// asset-select-all — a tiny bridge so the global keyboard router (interface
// submodule, editor-agnostic) can ask the Content Browser to select all of its
// currently-visible assets WITHOUT the interface package importing editor code.
//
// The CB registers its scoped handler at mount (wired to its live item list);
// the router's `deps.selectAllAssets` triggers it. This keeps the single
// keyboard-entry invariant (G-1 / AC-A1) while letting Ctrl+A select the assets
// the user is actually looking at — not a global catalog sweep.
// keyboard-router convergence M4 T4-2 / AC-A6.

let handler: (() => void) | null = null;

/** Content Browser registers its scoped "select all" here on mount (null on unmount). */
export function registerAssetSelectAllHandler(fn: (() => void) | null): void {
  handler = fn;
}

/** Trigger the registered handler (no-op if the CB isn't mounted). */
export function triggerAssetSelectAll(): void {
  handler?.();
}
