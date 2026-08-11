import { describe, expect, it } from 'bun:test';
import { isEdgeDrawerDismissExemptTarget } from './edgeDrawer';

describe('edge drawer outside-pointer guard', () => {
  it('keeps the drawer open for a portalled context-menu action', () => {
    const menuTarget = {
      closest: (selector: string) => selector.includes('.forgeax-ctx-menu-panel') ? menuTarget : null,
    } as unknown as Element;

    expect(isEdgeDrawerDismissExemptTarget(menuTarget)).toBe(true);
  });

  it('does not exempt an unrelated focused surface', () => {
    const otherSurface = {
      closest: () => null,
    } as unknown as Element;

    expect(isEdgeDrawerDismissExemptTarget(otherSurface)).toBe(false);
  });

  it('does not exempt a missing pointer target', () => {
    expect(isEdgeDrawerDismissExemptTarget(null)).toBe(false);
  });

  it('keeps the drawer open for an explicitly owned portal surface', () => {
    const ownedSurface = {
      closest: (selector: string) => selector.includes('[data-fx-interaction-scope]') ? ownedSurface : null,
    } as unknown as Element;

    expect(isEdgeDrawerDismissExemptTarget(ownedSurface)).toBe(true);
  });
});
