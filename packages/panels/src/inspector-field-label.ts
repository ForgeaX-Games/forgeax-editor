/**
 * camelCase / lowercase schema key → human label ("assetHandle" → "Asset Handle").
 * The raw key stays on the tooltip so producer-side naming remains discoverable.
 */
export function inspectorFieldLabel(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
