// packages/interface/src/appHostBootstrap.test.ts
//
// ADR 0025 M2 integration proof: declarative `contributes` flows through the
// bootstrap wrap into the contribution registry, host.panels is a derived
// memoized snapshot, and capability-driven activation/deactivation adds AND
// removes contributions at runtime — with onPanelsChange firing for React.
import { describe, expect, it } from 'bun:test';
import type React from 'react';
import { bootstrapAppHost } from './appHostBootstrap';
import type { AppExtension } from './core/app-shell';
import { qualifyContributionId } from '@forgeax/types';

const C = (() => null) as React.ComponentType;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('appHostBootstrap × contribution registry (M2)', () => {
  it('contributes-only extension (no setup) lands in host.panels; dispose removes it', async () => {
    const ext: AppExtension = {
      id: 'test.overlay', version: '1.0.0',
      contributes: { panels: { overlays: { Dashboard: C } } },
    };
    const r = await bootstrapAppHost({ extensions: [ext] });
    expect(r.host.panels.overlays?.Dashboard).toBe(C);
    await r.dispose();
    expect(r.host.panels.overlays?.Dashboard).toBeUndefined();
  });

  it('host.panels snapshot identity is stable between changes (memo by version)', async () => {
    const r = await bootstrapAppHost();
    const a = r.host.panels;
    const b = r.host.panels;
    expect(a).toBe(b);
    const off = r.control.contributePanels('test', { overlays: { Dashboard: C } });
    expect(r.host.panels).not.toBe(a);
    expect(r.host.panels.overlays?.Dashboard).toBe(C);
    off();
    await r.dispose();
  });

  it('capability-driven activate/deactivate adds and removes the contribution at runtime', async () => {
    const ext: AppExtension = {
      id: 'test.gated', version: '1.0.0',
      requires: ['test-cap'],
      contributes: { panels: { overlays: { Settings: C } } },
    };
    const r = await bootstrapAppHost({ extensions: [ext] });
    let changes = 0;
    const unsub = r.control.onPanelsChange(() => { changes++; });

    // pending — requires unsatisfied, nothing contributed
    expect(r.host.panels.overlays?.Settings).toBeUndefined();

    // capability appears → loader activates → contributes lands + change fires
    r.control.capabilities.add('test-cap');
    await tick(); await tick();
    expect(r.host.panels.overlays?.Settings).toBe(C);
    expect(changes).toBeGreaterThan(0);

    // capability removed → loader cleanup → contribution re-folds away
    const before = changes;
    r.control.capabilities.remove('test-cap');
    await tick(); await tick();
    expect(r.host.panels.overlays?.Settings).toBeUndefined();
    expect(changes).toBeGreaterThan(before);

    unsub();
    await r.dispose();
  });

  it('imperative ctx.contributePanels still works and composes with contributes', async () => {
    const stripItem = { id: 'test.chip', location: 'statusbar.left' as const, item: { type: 'text' as const, text: 'hi' } };
    const ext: AppExtension = {
      id: 'test.mixed', version: '1.0.0',
      contributes: { panels: { overlays: { Dashboard: C } } },
      setup(ctx) {
        return ctx.contributePanels({ stripItems: { 'test.chip': stripItem } });
      },
    };
    const r = await bootstrapAppHost({ extensions: [ext] });
    expect(r.host.panels.overlays?.Dashboard).toBe(C);
    expect(r.host.panels.stripItems?.['test.chip']).toBe(stripItem);
    await r.dispose();
    expect(r.host.panels.overlays?.Dashboard).toBeUndefined();
    expect(r.host.panels.stripItems?.['test.chip']).toBeUndefined();
  });

  it('activates and unloads declarative page + panel contributions as one bundle', async () => {
    const owner = '@forgeax-plugin/bootstrap-page';
    const pageId = qualifyContributionId(owner, 'page', 'main');
    const panelId = qualifyContributionId(owner, 'panel', 'main');
    const ext: AppExtension = {
      id: owner,
      version: '1.0.0',
      contributes: {
        panelTypes: [{ id: panelId, runtime: { kind: 'inline', render: () => null } }],
        pages: [{
          id: pageId,
          title: 'Main',
          cardinality: 'singleton',
          layout: { version: 1, root: { kind: 'tabs', placements: ['main'] } },
          panels: [{ id: 'main', panelTypeId: panelId }],
        }],
      },
    };
    const r = await bootstrapAppHost({ extensions: [ext] });
    expect(r.host.pageRegistry.get(pageId)?.status).toBe('available');
    await r.host.pages.open({ typeId: pageId });
    await r.dispose();
    expect(r.host.pageRegistry.get(pageId)).toBeUndefined();
    expect(r.host.pages.getSnapshot().instances).toHaveLength(0);
  });
});
