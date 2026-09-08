/** Edit-mode resolution policy: keep the viewport at least native-resolution. */
export const EDIT_VIEWPORT_MAX_PIXEL_RATIO = 1;

export function resolveEditViewportPixelRatio(devicePixelRatio: number): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio < 1) return 1;
  return Math.min(devicePixelRatio, EDIT_VIEWPORT_MAX_PIXEL_RATIO);
}
