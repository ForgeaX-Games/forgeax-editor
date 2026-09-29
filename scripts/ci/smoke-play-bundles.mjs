/** @typedef {'core' | 'breadth' | 'editor'} SmokePlayBundleId */

/** @type {Readonly<Record<SmokePlayBundleId, readonly string[]>>} */
export const SMOKE_PLAY_BUNDLES = Object.freeze({
  core: Object.freeze(['scriptable', 'broad-core']),
  breadth: Object.freeze(['template', 'broad-play', 'broad-assets', 'vfx']),
  editor: Object.freeze(['editor', 'create', 'repro']),
});

/** @type {readonly string[]} */
export const ALL_SMOKE_SHARDS = Object.freeze(Object.values(SMOKE_PLAY_BUNDLES).flat());

/** @type {readonly SmokePlayBundleId[]} */
export const SMOKE_PLAY_BUNDLE_IDS = Object.freeze(Object.keys(SMOKE_PLAY_BUNDLES));

/**
 * @param {string} bundle
 * @returns {readonly string[]}
 */
export function shardsForBundle(bundle) {
  const shards = SMOKE_PLAY_BUNDLES[bundle];
  if (!shards) {
    throw new Error(`unknown smoke-play bundle: ${bundle}`);
  }
  return shards;
}

/**
 * @param {string} bundle
 * @param {(shard: string) => void} visit
 */
export function forEachBundleShard(bundle, visit) {
  for (const shard of shardsForBundle(bundle)) {
    visit(shard);
  }
}
