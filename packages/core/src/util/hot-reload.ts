// Edit-mode hot-reload two-tier decision (plan-strategy D-8).
//
// When a gameplay / structure script is re-imported in edit mode, the editor
// must decide whether the live world can be kept (only system logic / tuning
// changed) or must be discarded and re-instantiated from the SceneAsset (a
// component SCHEMA changed — a field added / removed / retyped, so existing
// archetype columns no longer match).
//
// The judge is a fingerprint over every World-local component's reflected
// `fields` shape. Component definitions are the Engine ECS schema SSOT; no
// process-global catalog or legacy token serializer is consulted.
//   • same fingerprint  → 'world-update'  (keep the world, update systems)
//   • different fingerprint → 'world-rebuild' (drop the world, re-instantiate;
//                                A0' world is disposable, OOS-7/OOS-8)
//
// This module holds ONLY the pure decision logic (unit-tested in w30); the
// edit-runtime hot-reload orchestrator (edit-runtime/src/hot-reload.ts) supplies
// the live World catalog projection and performs the world mutation.

/** The minimal component-token surface the fingerprint reads. */
export interface SchemaSource {
  readonly fields: Readonly<Record<string, { readonly type: string }>>;
}

/** Which reload tier to take after a script re-import. */
export type ReloadTier = 'world-update' | 'world-rebuild';

/**
 * Stable fingerprint of World-local component schemas. Order-independent
 * (component and field names are sorted) so catalog insertion order does not
 * change the reload decision.
 */
export function schemaFingerprint(components: ReadonlyMap<string, SchemaSource>): string {
  const entries: Array<[string, string]> = [];
  for (const [name, token] of components) {
    const fields = Object.entries(token.fields)
      .map(([field, reflection]) => [field, reflection.type] as const)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    entries.push([name, JSON.stringify(fields)]);
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
