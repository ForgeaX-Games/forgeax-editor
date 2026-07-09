import { describe, expect, it } from 'bun:test';
import { buildTabContextMenuItems } from './tabContextMenu';
import type { DockRegion } from './regions';

describe('buildTabContextMenuItems', () => {
  it('DockShell region → "Move to Aux Bar" action moves panel to AuxBar', () => {
    const moves: Array<[string, DockRegion]> = [];
    const items = buildTabContextMenuItems('DockShell', 'chat', (id, r) => moves.push([id, r]));
    expect(items).toContain('close');
    expect(items).toContain('closeOthers');
    expect(items).toContain('separator');
    const custom = items.find((x): x is { label: string; action: () => void } =>
      typeof x === 'object' && x !== null && 'label' in x);
    expect(custom?.label).toBe('Move to Aux Bar');
    custom?.action();
    expect(moves).toEqual([['chat', 'AuxBar']]);
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

  it('items include close + closeOthers + separator (in that order) before the custom action', () => {
    const items = buildTabContextMenuItems('DockShell', 'chat', () => {});
    expect(items.slice(0, 3)).toEqual(['close', 'closeOthers', 'separator']);
  });
});
