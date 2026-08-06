import { describe, expect, it } from 'bun:test';
import { isOnSideEdge, nearerSideEdge } from './sideEdgeMove';

describe('isOnSideEdge', () => {
  it('true for left/right edge', () => {
    expect(isOnSideEdge({ type: 'edge', position: 'left' })).toBe(true);
    expect(isOnSideEdge({ type: 'edge', position: 'right' })).toBe(true);
  });

  it('false for bottom/top edge, grid, floating', () => {
    expect(isOnSideEdge({ type: 'edge', position: 'bottom' })).toBe(false);
    expect(isOnSideEdge({ type: 'edge', position: 'top' })).toBe(false);
    expect(isOnSideEdge({ type: 'grid' })).toBe(false);
    expect(isOnSideEdge({ type: 'floating' })).toBe(false);
  });
});

describe('nearerSideEdge', () => {
  const shell = { left: 0, right: 1000 };

  it('picks left when panel center is closer to left', () => {
    expect(nearerSideEdge({ left: 100, right: 200 }, shell)).toBe('left');
  });

  it('picks right when panel center is closer to right', () => {
    expect(nearerSideEdge({ left: 800, right: 900 }, shell)).toBe('right');
  });

  it('ties prefer left', () => {
    expect(nearerSideEdge({ left: 450, right: 550 }, shell)).toBe('left');
  });
});
