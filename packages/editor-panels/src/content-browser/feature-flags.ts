/**
 * Content Browser V2 feature flag.
 *
 * Set `localStorage.setItem('forgeax.cb.v2', '1')` to enable.
 * Default: disabled (uses existing AssetsPanel).
 */
export const CB_V2_ENABLED: boolean =
  typeof localStorage !== 'undefined' && localStorage.getItem('forgeax.cb.v2') === '1';
