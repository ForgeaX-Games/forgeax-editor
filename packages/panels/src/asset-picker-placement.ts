/** Viewport rect used to anchor the asset picker popover to a field control. */
export interface AssetPickerAnchor {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;
}

export function anchorFromElement(element: Element | null | undefined): AssetPickerAnchor | undefined {
  if (!element) return undefined;
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left,
    right: rect.right,
    width: rect.width,
    height: rect.height,
  };
}

const VIEWPORT_PAD = 8;
const MIN_PANEL_WIDTH = 300;
const MAX_PANEL_WIDTH = 420;
export const MIN_PANEL_HEIGHT = 300;
export const DEFAULT_PANEL_HEIGHT = 400;

export interface AssetPickerPlacement {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly placement: 'below' | 'above';
}

/** Pick above/below based on available viewport space, then clamp into view. */
export function computeAssetPickerPlacement(
  anchor: AssetPickerAnchor,
  panelHeight: number = DEFAULT_PANEL_HEIGHT,
  gap: number = 4,
): AssetPickerPlacement {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const width = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, anchor.width, 320));
  const left = Math.min(Math.max(anchor.left, VIEWPORT_PAD), vw - width - VIEWPORT_PAD);

  const spaceBelow = vh - anchor.bottom - VIEWPORT_PAD;
  const spaceAbove = anchor.top - VIEWPORT_PAD;
  const openAbove = spaceBelow < panelHeight && spaceAbove > spaceBelow;
  const maxHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(panelHeight, openAbove ? spaceAbove - gap : spaceBelow - gap));
  const minHeight = Math.min(MIN_PANEL_HEIGHT, maxHeight);

  const top = openAbove
    ? Math.max(VIEWPORT_PAD, anchor.top - gap - maxHeight)
    : Math.min(anchor.bottom + gap, vh - maxHeight - VIEWPORT_PAD);

  return {
    top,
    left,
    width,
    minHeight,
    maxHeight,
    placement: openAbove ? 'above' : 'below',
  };
}
