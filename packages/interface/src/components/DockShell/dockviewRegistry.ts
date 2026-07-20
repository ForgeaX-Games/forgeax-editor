// Module singleton: viewId → DockviewApi. DockRegion instances register their
// api on mount, unregister on unmount. Cross-instance drop handlers look up
// the SOURCE api here to close the panel on the origin side.
//
// Type import is loose (unknown-shape API) to avoid a hard dep on dockview
// internal types beyond what the drop handler actually calls.
export interface DockviewApiLike {
  readonly id: string;
  getPanel(id: string): { readonly api: { close(): void } } | undefined;
}

const registry = new Map<string, DockviewApiLike>();

export function registerDockviewApi(api: DockviewApiLike): () => void {
  registry.set(api.id, api);
  return () => { if (registry.get(api.id) === api) registry.delete(api.id); };
}

export function getDockviewApi(viewId: string): DockviewApiLike | undefined {
  return registry.get(viewId);
}
