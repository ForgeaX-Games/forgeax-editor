// Edit-mode hot-reload two-tier decision (plan-strategy D-8).
//
// When a gameplay / structure script is re-imported in edit mode, the editor
// must decide whether the live world can be kept (only system logic / tuning
// changed) or must be discarded and re-instantiated from the SceneAsset (a
// component SCHEMA changed — a field added / removed / retyped, so existing
// archetype columns no longer match).
//
// The judge is a fingerprint over every registered component's `toSchemaJSON()`
// (engine `component.toSchemaJSON` @ component.ts:660; research Finding 1):
//   • same fingerprint  → 'world-update'  (keep the world, update systems)
//   • different fingerprint → 'world-rebuild' (drop the world, re-instantiate;
//                                A0' world is disposable, OOS-7/OOS-8)
//
// This module holds ONLY the pure decision logic (unit-tested in w30); the
// edit-runtime hot-reload orchestrator (edit-runtime/src/hot-reload.ts) supplies
// the live `getRegisteredComponents()` map and performs the world mutation.

/** The minimal component-token surface the fingerprint reads. */
export interface SchemaSource {
  toSchemaJSON(): string;
}

/** Which reload tier to take after a script re-import. */
export type ReloadTier = 'world-update' | 'world-rebuild';

/**
 * Stable fingerprint of the registered component schemas. Order-independent
 * (component names are sorted) so a re-registration that reorders the map but
 * keeps every schema identical produces the SAME fingerprint → world-update.
 */
export function schemaFingerprint(components: ReadonlyMap<string, SchemaSource>): string {
  const entries: Array<[string, string]> = [];
  for (const [name, token] of components) {
    entries.push([name, token.toSchemaJSON()]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * Decide the reload tier from the schema fingerprints captured before and after
 * a script re-import. Identical fingerprints mean no component schema changed →
 * the live world stays valid (world-update); any difference means an archetype
 * column shape changed → the world must be rebuilt (world-rebuild).
 */
export function decideReloadTier(before: string, after: string): ReloadTier {
  return before === after ? 'world-update' : 'world-rebuild';
}
