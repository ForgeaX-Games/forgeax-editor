import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { HierarchyPanel } from './Hierarchy';
import { InspectorPanel } from './Inspector';
import { AssetsPanel } from './Assets';
import { HistoryPanel } from './History';
import { CapabilitiesPanel } from './Capabilities';
import { MaterialPanel } from './Material';
import { TimelinePanel } from './Timeline';
import { MaterialGraphPanel } from './MaterialGraph';
import { announcePopoutClosing, announcePopoutGeom } from '../store';
import type { SyncPanelId } from '../core/sync-channel';

// DetachedPanel — the root rendered inside a popped-out OS window (design
// EDITOR-MODE §0.2.2 "弹出 Pop-out"). The window loads the SAME /editor/ bundle
// with `?panel=<id>`, so main.tsx mounts ONLY this one panel instead of the full
// editor chrome (no engine canvas, no toolbar). It mirrors the main window's bus
// over a BroadcastChannel (see store.initSync), so edits here drive the same
// scene the main window renders — what you change is what plays.

const TITLE: Record<SyncPanelId, string> = {
  hierarchy: 'Hierarchy',
  assets: 'Assets',
  inspector: 'Inspector',
  history: 'History',
  capabilities: 'Capabilities',
  material: 'Material',
  timeline: 'Timeline',
  matgraph: 'Mat Graph',
};
const BODY: Record<SyncPanelId, () => ReactNode> = {
  hierarchy: () => <HierarchyPanel />,
  assets: () => <AssetsPanel />,
  inspector: () => <InspectorPanel />,
  history: () => <HistoryPanel />,
  capabilities: () => <CapabilitiesPanel />,
  material: () => <MaterialPanel />,
  timeline: () => <TimelinePanel />,
  matgraph: () => <MaterialGraphPanel />,
};

export function DetachedPanel({ panel }: { panel: SyncPanelId }): ReactNode {
  // On close (native button OR our redock button → window.close()), tell the
  // main window to redock this panel. pagehide fires for both reload and close;
  // the main window simply re-shows the panel in its dock.
  useEffect(() => {
    const onHide = () => {
      // Remember where/how big this window is so the next pop-out reopens here
      // (design §0.2.3). outerWidth/Height covers the OS window incl. chrome;
      // screenX/Y is its on-desktop position. Guard NaN/0 from odd runtimes.
      const w = window.outerWidth || window.innerWidth || 0;
      const h = window.outerHeight || window.innerHeight || 0;
      const x = Number.isFinite(window.screenX) ? window.screenX : 0;
      const y = Number.isFinite(window.screenY) ? window.screenY : 0;
      if (w > 0 && h > 0) announcePopoutGeom(panel, { w, h, x, y });
      announcePopoutClosing(panel);
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [panel]);

  return (
    <div className="ed-overlay ed-popout" data-testid="editor-popout" data-panel={panel}>
      <div className="popout-head">
        <span className="ph-title">⠿ {TITLE[panel]}</span>
        <span className="ph-sp" />
        <button
          type="button"
          className="ph-redock"
          title="停靠回主窗"
          onClick={() => window.close()}
        >
          ⊟ 停靠
        </button>
      </div>
      <div className="popout-body">{BODY[panel]()}</div>
    </div>
  );
}
