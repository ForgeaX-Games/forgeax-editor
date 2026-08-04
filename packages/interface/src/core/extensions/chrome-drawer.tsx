// packages/interface/src/core/extensions/chrome-drawer.tsx
//
// ADR-0030 §2.3 — interface-owned bottom-drawer wiring. Contributes the
// interface's neutral drawer panels (today: Info) through the single panels
// channel, and registers the drawer's UI-layout commands so any caller
// (keyboard / palette / a status chip / iframe) toggles it through one entry.
import type { AppExtension } from '../app-shell/types';
import { InfoPanel } from '../../components/StatusBar/InfoPanel';
import { checkpointsDrawerPanel } from '../../components/StatusBar/footer/CheckpointsDrawer';
import { eventsDrawerPanel } from '../../components/StatusBar/footer/EventsDrawer';
import { useDrawerStore } from '../../components/Drawer/useDrawerStore';
import { DrawerLauncher } from '../../components/Drawer/DrawerLauncher';

export const chromeDrawerExtension: AppExtension = {
  id: 'chrome.drawer',
  version: '1.0.0',
  requires: ['commands'],
  contributes: {
    panels: {
      // The launcher tabs live IN the status bar (single-row footer): one strip
      // item renders all drawer launcher tabs, self-subscribing for active
      // highlight. Priority BELOW the version chip (1000) so it sorts to the
      // RIGHT end of the left group rather than the far left.
      stripItems: {
        'drawer.launcher': {
          kind: 'status-item',
          id: 'drawer.launcher',
          location: 'statusbar.left',
          priority: 900,
          item: { type: 'custom', render: () => <DrawerLauncher /> },
        },
      },
      drawerPanels: {
        // Blender-INFO-style health/log feed. Moved from an OPTIONAL dock panel
        // to the bottom drawer (ADR-0030): registers a launcher tab that expands
        // upward, replacing its former dock-panel home.
        info: {
          id: 'info',
          title: 'Info',
          titleKey: 'footerPanel.info',
          icon: 'Info',
          order: 0,
          render: () => <InfoPanel />,
        },
        // Demo footer drawers (page-only replicas): commit-timeline checkpoints
        // and the gateway event feed. Same `drawer` shape as Info — launcher
        // tabs derive automatically next to it (ADR-0030 §2.3).
        checkpoints: checkpointsDrawerPanel,
        events: eventsDrawerPanel,
      },
    },
  },
  setup(ctx) {
    const cleanups: Array<() => void> = [];
    const idOf = (args: unknown): string | undefined => (args as { id?: string })?.id;

    cleanups.push(ctx.registerCommand({
      id: 'app.drawer.toggle',
      title: 'Toggle a bottom drawer panel by id',
      execute: (args) => {
        const id = idOf(args);
        if (!id) throw new Error('app.drawer.toggle: missing { id }');
        useDrawerStore.getState().toggle(id);
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(ctx.registerCommand({
      id: 'app.drawer.open',
      title: 'Open (expand) a bottom drawer panel by id',
      execute: (args) => {
        const id = idOf(args);
        if (!id) throw new Error('app.drawer.open: missing { id }');
        useDrawerStore.getState().open(id);
        return { status: 'completed' as const };
      },
    }));

    cleanups.push(ctx.registerCommand({
      id: 'app.drawer.close',
      title: 'Collapse the bottom drawer',
      execute: () => {
        useDrawerStore.getState().close();
        return { status: 'completed' as const };
      },
    }));

    return () => { for (const c of cleanups.reverse()) c(); };
  },
};
