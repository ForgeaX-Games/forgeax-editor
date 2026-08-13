import { describe, expect, it } from 'bun:test';
import { buildTabContextMenuItems } from './tabContextMenu';
import type { DockRegion } from './regions';

describe('buildTabContextMenuItems', () => {
  it('DockShell off-side → "Move to Side" calls onMoveToSide with nearerSide', () => {
    const sides: string[] = [];
    const items = buildTabContextMenuItems(
      'DockShell',
      'inspector',
      () => {},
      undefined,
      {
        onSideEdge: false,
        nearerSide: 'right',
        onMoveToSide: (s) => sides.push(s),
        onMoveOffSide: () => {},
      },
    );
    const custom = items.find((x): x is { label: string; action: () => void } =>
      typeof x === 'object' && x !== null && 'label' in x && x.label === 'Move to Side');
    expect(custom).toBeDefined();
    custom?.action();
    expect(sides).toEqual(['right']);
  });

  it('DockShell on-side → "Move off Side" calls onMoveOffSide', () => {
    let off = 0;
    const items = buildTabContextMenuItems(
      'DockShell',
      'hierarchy',
      () => {},
      undefined,
      {
        onSideEdge: true,
        nearerSide: 'left',
        onMoveToSide: () => {},
        onMoveOffSide: () => { off += 1; },
      },
    );
    const custom = items.find((x): x is { label: string; action: () => void } =>
      typeof x === 'object' && x !== null && 'label' in x && x.label === 'Move off Side');
    expect(custom).toBeDefined();
    custom?.action();
    expect(off).toBe(1);
  });

  it('AuxBar region → "Move to Primary Dock" action moves panel to DockShell', () => {
    const moves: Array<[string, DockRegion]> = [];
    const items = buildTabContextMenuItems('AuxBar', 'chat', (id, r) => moves.push([id, r]));
    const custom = items.find((x): x is { label: string; action: () => void } =>
      typeof x === 'object' && x !== null && 'label' in x);
    expect(custom?.label).toBe('Move to Primary Dock');
    custom?.action();
    expect(moves).toEqual([['chat', 'DockShell']]);
  });

  it('without close handlers → falls back to built-in close + closeOthers + separator ids', () => {
    const items = buildTabContextMenuItems(
      'DockShell',
      'chat',
      () => {},
      undefined,
      {
        onSideEdge: false,
        nearerSide: 'left',
        onMoveToSide: () => {},
        onMoveOffSide: () => {},
      },
    );
    expect(items.slice(0, 3)).toEqual(['close', 'closeOthers', 'separator']);
  });

  it('with close handlers → localized close + closeOthers custom items wired to the API', () => {
    let closed = 0;
    let closedOthers = 0;
    const items = buildTabContextMenuItems(
      'DockShell',
      'chat',
      () => {},
      undefined,
      undefined,
      { onClose: () => { closed += 1; }, onCloseOthers: () => { closedOthers += 1; } },
    );
    const [close, closeOthers, sep] = items;
    expect(typeof close === 'object' && close.label).toBe('Close');
    expect(typeof closeOthers === 'object' && closeOthers.label).toBe('Close Others');
    expect(sep).toBe('separator');
    if (typeof close === 'object') close.action();
    if (typeof closeOthers === 'object') closeOthers.action();
    expect(closed).toBe(1);
    expect(closedOthers).toBe(1);
  });

  it('single-panel groups offer a title-bar hide action', () => {
    let hidden = false;
    const items = buildTabContextMenuItems('DockShell', 'chat', () => {}, {
      groupPanelCount: 1,
      onHideTitle: () => { hidden = true; },
    });
    const hide = items.find((x): x is { label: string; action: () => void } =>
      typeof x === 'object' && x !== null && x.label === 'Hide Panel Title Bar');
    expect(hide).toBeDefined();
    hide?.action();
    expect(hidden).toBe(true);
  });

  it('multi-panel groups do not offer a title-bar hide action', () => {
    const items = buildTabContextMenuItems('DockShell', 'chat', () => {}, {
      groupPanelCount: 2,
      onHideTitle: () => {},
    });
    expect(items.some((x) => typeof x === 'object' && x.label === 'Hide Panel Title Bar')).toBe(false);
  });

  it('side-edge single-panel groups do not offer a title-bar hide action', () => {
    const items = buildTabContextMenuItems(
      'DockShell',
      'hierarchy',
      () => {},
      { groupPanelCount: 1, onHideTitle: () => {} },
      { onSideEdge: true, nearerSide: 'left', onMoveToSide: () => {}, onMoveOffSide: () => {} },
    );
    expect(items.some((x) => typeof x === 'object' && x.label === 'Hide Panel Title Bar')).toBe(false);
  });

  it('declared windowing capability contributes the localized pop-out action', () => {
    let opened = 0;
    const items = buildTabContextMenuItems(
      'DockShell',
      'chat',
      () => {},
      undefined,
      undefined,
      undefined,
      { onPopOut: () => { opened += 1; } },
    );
    const popOut = items.find((item): item is { label: string; action: () => void } =>
      typeof item === 'object' && item.label === 'Open in New Window');
    expect(popOut).toBeDefined();
    popOut?.action();
    expect(opened).toBe(1);
  });

  it('omits the pop-out action when no windowing capability is declared', () => {
    const items = buildTabContextMenuItems('DockShell', 'ep:inspector', () => {});
    expect(items.some((item) =>
      typeof item === 'object' && item.label === 'Open in New Window')).toBe(false);
  });
});
