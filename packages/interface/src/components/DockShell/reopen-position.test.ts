// reopen-position.test.ts — regression guard for the "closed panel reopens
// bound to a foreign group" bug. DockRegion.reopen must seat a page panel
// back at its DESIGNED position from the Page Type default layout (Material:
// preview left, properties/overview stacked right), not blindly right of the
// last grid panel.
import { describe, expect, it } from 'bun:test';
import { Orientation, type SerializedDockview } from 'dockview';
import { designedPanelPosition } from './reopen-position';

const leaf = (views: string[]): SerializedDockview['grid']['root'] => ({
  type: 'leaf',
  size: 100,
  data: { views, activeView: views[0], id: `g-${views[0]}` },
});
const branch = (...data: SerializedDockview['grid']['root'][]): SerializedDockview['grid']['root'] => ({
  type: 'branch',
  size: 100,
  data,
});

function layoutOf(root: SerializedDockview['grid']['root']): SerializedDockview {
  return {
    grid: { height: 812, width: 1200, orientation: Orientation.HORIZONTAL, root },
    panels: {},
  };
}

// Mirrors DEFAULT_MATERIAL_EDITOR_DOCK_LAYOUT: preview | (properties / overview).
const MATERIAL = layoutOf(
  branch(
    leaf(['ep:mat-preview']),
    branch(leaf(['ep:asset-properties']), leaf(['ep:asset-overview'])),
  ),
);

const opener =
  (...open: string[]) =>
  (id: string): boolean =>
    open.includes(id);

describe('designedPanelPosition', () => {
  it('seats the material preview on the LEFT grid edge (full-height column)', () => {
    // The preview leaf is a direct root child at index 0 — a relative anchor
    // would only capture the sibling's slice of the grid.
    expect(designedPanelPosition(MATERIAL, 'ep:mat-preview', opener('ep:asset-properties', 'ep:asset-overview')))
      .toEqual({ kind: 'edge', direction: 'left' });
  });

  it('stacks properties above / overview below inside the right column', () => {
    expect(designedPanelPosition(MATERIAL, 'ep:asset-properties', opener('ep:asset-overview')))
      .toEqual({ kind: 'relative', referencePanel: 'ep:asset-overview', direction: 'above' });
    expect(designedPanelPosition(MATERIAL, 'ep:asset-overview', opener('ep:asset-properties')))
      .toEqual({ kind: 'relative', referencePanel: 'ep:asset-properties', direction: 'below' });
  });

  it('climbs to the parent branch when no same-branch sibling is open', () => {
    expect(designedPanelPosition(MATERIAL, 'ep:asset-properties', opener('ep:mat-preview')))
      .toEqual({ kind: 'relative', referencePanel: 'ep:mat-preview', direction: 'right' });
  });

  it('rejoins a surviving tab-mate instead of splitting a new group', () => {
    const tabbed = layoutOf(branch(leaf(['ep:assets', 'ep:history']), leaf(['viewport'])));
    expect(designedPanelPosition(tabbed, 'ep:history', opener('ep:assets', 'viewport')))
      .toEqual({ kind: 'relative', referencePanel: 'ep:assets', direction: 'within' });
  });

  it('returns undefined when nothing can anchor it (caller falls back)', () => {
    const nestedOnly = layoutOf(
      branch(branch(leaf(['ep:hierarchy']), leaf(['ep:inspector'])), leaf(['viewport'])),
    );
    expect(designedPanelPosition(nestedOnly, 'ep:hierarchy', opener())).toBeUndefined();
    expect(designedPanelPosition(MATERIAL, 'ep:unknown', opener('ep:asset-properties'))).toBeUndefined();
  });

  it('walks nested branches with alternating orientation', () => {
    // Level-like: [hierarchy / inspector] | viewport
    const level = layoutOf(
      branch(branch(leaf(['ep:hierarchy']), leaf(['ep:inspector'])), leaf(['viewport'])),
    );
    expect(designedPanelPosition(level, 'ep:hierarchy', opener('ep:inspector', 'viewport')))
      .toEqual({ kind: 'relative', referencePanel: 'ep:inspector', direction: 'above' });
    expect(designedPanelPosition(level, 'ep:hierarchy', opener('viewport')))
      .toEqual({ kind: 'relative', referencePanel: 'viewport', direction: 'left' });
  });

  it('seats a direct root leaf at the trailing edge on the opposite side', () => {
    // Level's chat column: direct root child at the last index → right edge.
    const level = layoutOf(
      branch(branch(leaf(['ep:hierarchy']), leaf(['ep:inspector'])), leaf(['viewport']), leaf(['chat'])),
    );
    expect(designedPanelPosition(level, 'chat', opener('viewport')))
      .toEqual({ kind: 'edge', direction: 'right' });
  });
});
