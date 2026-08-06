// packages/interface/src/core/extensions/chrome-drawer.tsx
//
// Info / Checkpoints / Events USED to be bottom-drawer contributions here (a
// launcher strip item + `drawerPanels`, consumed by DrawerHostView). They are
// now real dockview panels that default into the footer-merged bottom EDGE
// group (see panelRegistry.tsx + the built-in layouts' `edgeGroups.bottom`).
//
// This extension keeps the `app.drawer.*` command surface (callers like the
// HealthIndicator chip toggle "Info" through it) but retargets it at the edge
// drawer: the commands dispatch a `forgeax:edge-drawer` window event that
// edgeDrawer.ts consumes to activate the panel + open/close its footer flyout.
import type { AppExtension } from '../app-shell/types';

export const EDGE_DRAWER_EVENT = 'forgeax:edge-drawer';

type EdgeDrawerAction = 'open' | 'toggle' | 'close';

function dispatchEdgeDrawer(action: EdgeDrawerAction, id?: string): void {
  window.dispatchEvent(new CustomEvent(EDGE_DRAWER_EVENT, { detail: { action, id } }));
}

export const chromeDrawerExtension: AppExtension = {
  id: 'chrome.drawer',
  version: '2.0.0',
  requires: ['commands'],
  setup(ctx) {
    const cleanups: Array<() => void> = [];
    const idOf = (args: unknown): string | undefined => (args as { id?: string })?.id;

    cleanups.push(ctx.registerCommand({
      id: 'app.drawer.toggle',
      title: 'Toggle a footer bottom-edge panel by id',
      execute: (args) => {
        const id = idOf(args);
        if (!id) throw new Error('app.drawer.toggle: missing { id }');
        dispatchEdgeDrawer('toggle', id);
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(ctx.registerCommand({
      id: 'app.drawer.open',
      title: 'Open (expand) a footer bottom-edge panel by id',
      execute: (args) => {
        const id = idOf(args);
        if (!id) throw new Error('app.drawer.open: missing { id }');
        dispatchEdgeDrawer('open', id);
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(ctx.registerCommand({
      id: 'app.drawer.close',
      title: 'Collapse the footer bottom-edge drawer',
      execute: () => {
        dispatchEdgeDrawer('close');
        return { status: 'completed' as const };
      },
    }));

    return () => { for (const c of cleanups.reverse()) c(); };
  },
};
