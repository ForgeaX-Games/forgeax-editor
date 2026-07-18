// packages/interface/src/core/app-shell/derive-panel-renderers.test.ts
//
// Semantics ported from the retired foundation-panels.test.ts (mergePanels),
// re-expressed against the pure fold + registry re-fold model (ADR 0025 M2).
import { describe, expect, it } from 'bun:test';
import type React from 'react';
import { DEFAULT_PANEL_RENDERERS, type PanelRenderers } from '../../components/DockShell/panelRenderers';
import { derivePanelRenderers } from './derive-panel-renderers';

const C = (() => null) as React.ComponentType;

describe('derivePanelRenderers', () => {
  it('one-level sub-merge: later patch wins per sub-key, siblings preserved', () => {
    const out = derivePanelRenderers(DEFAULT_PANEL_RENDERERS, [
      { overlays: { Dashboard: C } },
      { overlays: { Settings: C } },
    ]);
    expect(out.overlays?.Dashboard).toBe(C);
    expect(out.overlays?.Settings).toBe(C);
  });

  it('removal = re-fold without the entry (replaces undo closures)', () => {
    const patches = [
      { overlays: { Dashboard: C } },
      { overlays: { Settings: C } },
    ];
    const without = derivePanelRenderers(DEFAULT_PANEL_RENDERERS, [patches[1]!]);
    expect(without.overlays?.Dashboard).toBeUndefined();
    expect(without.overlays?.Settings).toBe(C);
  });

  it('workbenchPanels sub-key merge preserves siblings', () => {
    const a = (): React.ReactNode => null;
    const b = (): React.ReactNode => null;
    const out = derivePanelRenderers(DEFAULT_PANEL_RENDERERS, [
      { workbenchPanels: { 'wb:a': a } },
      { workbenchPanels: { 'wb:b': b } },
    ]);
    expect(out.workbenchPanels?.['wb:a']).toBe(a);
    expect(out.workbenchPanels?.['wb:b']).toBe(b);
  });

  it('array fields REPLACE whole-value; later patch wins', () => {
    const out = derivePanelRenderers(DEFAULT_PANEL_RENDERERS, [
      { editorPanelIds: ['a', 'b'] },
      { editorPanelIds: ['c'] },
    ]);
    expect(out.editorPanelIds).toEqual(['c']);
  });

  it('never mutates base or its sub-objects', () => {
    const base: PanelRenderers = { ...DEFAULT_PANEL_RENDERERS, overlays: {} };
    const baseOverlays = base.overlays;
    const out = derivePanelRenderers(base, [{ overlays: { Dashboard: C } }]);
    expect(baseOverlays).toEqual({});
    expect(out.overlays).not.toBe(baseOverlays);
  });

  it('undefined patch fields are skipped', () => {
    const out = derivePanelRenderers(DEFAULT_PANEL_RENDERERS, [
      { overlays: { Dashboard: C }, surfaces: undefined },
    ]);
    expect(out.surfaces).toBeUndefined();
    expect(out.overlays?.Dashboard).toBe(C);
  });
});
