// Pure helpers for the tab context-menu "Move to Side" / "Move off Side" action.
// "Side" = left/right edge strips only (bottom/top are not side menus).

export type SideEdge = 'left' | 'right';

export interface RectLike {
  left: number;
  right: number;
}

/** True when the panel lives in the left or right edge strip. */
export function isOnSideEdge(location: {
  type: string;
  position?: string;
}): boolean {
  return location.type === 'edge'
    && (location.position === 'left' || location.position === 'right');
}

/**
 * Pick the nearer side strip by comparing the panel's horizontal center to the
 * shell's left/right edges. Ties prefer left.
 */
export function nearerSideEdge(panel: RectLike, shell: RectLike): SideEdge {
  const mid = (panel.left + panel.right) / 2;
  const distLeft = mid - shell.left;
  const distRight = shell.right - mid;
  return distLeft <= distRight ? 'left' : 'right';
}
