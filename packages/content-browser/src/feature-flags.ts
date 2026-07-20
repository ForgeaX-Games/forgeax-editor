/**
 * Content Browser V2 feature flag.
 *
 * Default: enabled (V2 with toolbar, multi-select, virtualization).
 * Set `localStorage.setItem('forgeax.cb.v2', '0')` to revert to V1.
 */
export const CB_V2_ENABLED: boolean =
  typeof localStorage === 'undefined' || localStorage.getItem('forgeax.cb.v2') !== '0';
