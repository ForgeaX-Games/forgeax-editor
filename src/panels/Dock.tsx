import { useEffect, useReducer, useRef } from 'react';
import type { CSSProperties, PointerEvent as RPointerEvent, ReactNode } from 'react';
import { HierarchyPanel } from './Hierarchy';
import { InspectorPanel } from './Inspector';
import { AssetsPanel } from './Assets';
import { HistoryPanel } from './History';
import { CapabilitiesPanel } from './Capabilities';

// DockManager — the editor's window/docking shell (design EDITOR-MODE §21 + the
// §01/§02 mockup): panels are dock leaves you DRAG by their tab; drop near a dock
// edge (left/right/bottom) to dock there (joining that region as a TAB), drop over
// the center to FLOAT a draggable/resizable/closeable window. No float buttons —
// the drop location decides. A region is a TabGroup (one active panel + tab bar).
// Layout + active tabs persist to localStorage (versioned). Custom lightweight
// take (dockview isn't installable here); recursive split tree + OS-window
// pop-out (Tauri) remain future work.

type PanelId = 'hierarchy' | 'assets' | 'inspector' | 'history' | 'capabilities';
type Region = 'left' | 'right' | 'bottom';
type Zone = Region | 'float';
type Placement =
  | { kind: 'dock'; region: Region; order: number }
  | { kind: 'float'; x: number; y: number; w: number; h: number };
type Layout = Record<PanelId, Placement>;
type Active = Partial<Record<Region, PanelId>>;

const TITLE: Record<PanelId, string> = { hierarchy: 'Hierarchy', assets: 'Assets', inspector: 'Inspector', history: 'History', capabilities: 'Capabilities' };
const BODY: Record<PanelId, () => ReactNode> = {
  hierarchy: () => <HierarchyPanel />,
  assets: () => <AssetsPanel />,
  inspector: () => <InspectorPanel />,
  history: () => <HistoryPanel />,
  capabilities: () => <CapabilitiesPanel />,
};
const ALL: PanelId[] = ['hierarchy', 'assets', 'inspector', 'history', 'capabilities'];

const LS_KEY = 'forgeax:editor:layout:v3';
const DEFAULT_LAYOUT: Layout = {
  hierarchy: { kind: 'dock', region: 'left', order: 0 },
  assets: { kind: 'dock', region: 'left', order: 1 },
  inspector: { kind: 'dock', region: 'right', order: 0 },
  history: { kind: 'dock', region: 'bottom', order: 0 },
  capabilities: { kind: 'dock', region: 'bottom', order: 1 },
};

interface Saved { v: number; layout: Layout; active?: Active }
function loadSaved(): { layout: Layout; active: Active } {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const o = JSON.parse(raw) as Saved;
      if (o.v === 3 && o.layout && ALL.every((id) => o.layout[id])) return { layout: o.layout, active: o.active ?? {} };
    }
  } catch { /* corrupt → default */ }
  return { layout: { ...DEFAULT_LAYOUT }, active: {} };
}
function save(layout: Layout, active: Active): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ v: 3, layout, active })); } catch { /* quota */ }
}

export function DockManager() {
  const init = loadSaved();
  const layoutRef = useRef<Layout>(init.layout);
  const activeRef = useRef<Active>(init.active);
  const [, force] = useReducer((n: number) => n + 1, 0);
  const dockRef = useRef<HTMLDivElement | null>(null);
  // transient drag state (refs, updated at pointer rate — no stale closures).
  const drag = useRef<{ id: PanelId; grabX: number; grabY: number; sx: number; sy: number; px: number; py: number; moved: boolean; zone: Zone } | null>(null);
  const [, forceDrag] = useReducer((n: number) => n + 1, 0);

  const commit = (next: Layout): void => { layoutRef.current = next; save(next, activeRef.current); force(); };
  const setActive = (region: Region, id: PanelId): void => { activeRef.current = { ...activeRef.current, [region]: id }; save(layoutRef.current, activeRef.current); force(); };

  function zoneAt(px: number, py: number): Zone {
    const r = dockRef.current?.getBoundingClientRect();
    if (!r) return 'float';
    const fx = (px - r.left) / r.width, fy = (py - r.top) / r.height;
    if (fx < 0.16) return 'left';
    if (fx > 0.84) return 'right';
    if (fy > 0.80) return 'bottom';
    return 'float';
  }
  function nextOrder(layout: Layout, region: Region): number {
    let m = -1;
    for (const id of ALL) { const p = layout[id]; if (p.kind === 'dock' && p.region === region) m = Math.max(m, p.order); }
    return m + 1;
  }

  function startDrag(id: PanelId, e: RPointerEvent): void {
    e.preventDefault();
    const p = layoutRef.current[id];
    const grabX = p.kind === 'float' ? e.clientX - p.x : 12;
    const grabY = p.kind === 'float' ? e.clientY - p.y : 12;
    drag.current = { id, grabX, grabY, sx: e.clientX, sy: e.clientY, px: e.clientX, py: e.clientY, moved: false, zone: zoneAt(e.clientX, e.clientY) };
    forceDrag();
  }

  useEffect(() => {
    function onMove(e: PointerEvent): void {
      const d = drag.current;
      if (!d) return;
      d.px = e.clientX; d.py = e.clientY;
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) d.moved = true;
      const cur = layoutRef.current[d.id];
      if (cur.kind === 'float' && d.moved) {
        layoutRef.current = { ...layoutRef.current, [d.id]: { ...cur, x: e.clientX - d.grabX, y: e.clientY - d.grabY } };
      }
      d.zone = zoneAt(e.clientX, e.clientY);
      forceDrag();
    }
    function onUp(e: PointerEvent): void {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      if (!d.moved) { forceDrag(); return; } // a click (tab switch handled by onClick)
      const zone = zoneAt(e.clientX, e.clientY);
      const layout = { ...layoutRef.current };
      if (zone === 'float') {
        const prev = layout[d.id];
        layout[d.id] = prev.kind === 'float'
          ? { ...prev, x: e.clientX - d.grabX, y: e.clientY - d.grabY }
          : { kind: 'float', x: Math.max(8, e.clientX - 120), y: Math.max(40, e.clientY - 14), w: 260, h: 340 };
      } else {
        layout[d.id] = { kind: 'dock', region: zone, order: nextOrder(layout, zone) };
        activeRef.current = { ...activeRef.current, [zone]: d.id }; // show the just-docked panel
      }
      commit(layout);
      forceDrag();
    }
    function onReset(): void {
      layoutRef.current = { ...DEFAULT_LAYOUT };
      activeRef.current = {};
      save(layoutRef.current, activeRef.current);
      force();
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('forgeax:editor:dock-reset', onReset as EventListener);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('forgeax:editor:dock-reset', onReset as EventListener);
    };
  }, []);

  function startResize(id: PanelId, e: RPointerEvent): void {
    e.preventDefault(); e.stopPropagation();
    const p = layoutRef.current[id];
    if (p.kind !== 'float') return;
    const sx = e.clientX, sy = e.clientY, sw = p.w, sh = p.h;
    function mv(ev: PointerEvent): void {
      const cur = layoutRef.current[id];
      if (cur.kind !== 'float') return;
      layoutRef.current = { ...layoutRef.current, [id]: { ...cur, w: Math.max(160, sw + ev.clientX - sx), h: Math.max(120, sh + ev.clientY - sy) } };
      forceDrag();
    }
    function up(): void { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); commit(layoutRef.current); }
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  }

  const redock = (id: PanelId): void => {
    const layout = { ...layoutRef.current };
    layout[id] = { ...DEFAULT_LAYOUT[id] } as Placement;
    commit(layout);
  };

  const layout = layoutRef.current;
  const inRegion = (r: Region) => ALL.filter((id) => { const p = layout[id]; return p.kind === 'dock' && p.region === r; })
    .sort((a, b) => (layout[a] as { order: number }).order - (layout[b] as { order: number }).order);
  const left = inRegion('left'), right = inRegion('right'), bottom = inRegion('bottom');
  const floats = ALL.filter((id) => layout[id].kind === 'float');

  // A docked region = a TabGroup: a tab bar (drag a tab to move; click to switch)
  // over the active panel's body.
  const regionLeaf = (region: Region, ids: PanelId[]): ReactNode => {
    if (!ids.length) return null;
    const active = ids.includes(activeRef.current[region] as PanelId) ? (activeRef.current[region] as PanelId) : ids[0]!;
    return (
      <div className="dockleaf" data-dock-pe="1">
        <div className="docktabs">
          {ids.map((id) => (
            <div key={id} className={`docktab${id === active ? ' on' : ''}`} title="拖动以浮动 / 停靠;单击切换"
              onPointerDown={(e) => startDrag(id, e)} onClick={() => setActive(region, id)}>
              <span className="dh-grip">⠿</span>{TITLE[id]}
            </div>
          ))}
        </div>
        <div className="dockbody">{BODY[active]()}</div>
      </div>
    );
  };

  const floatLeaf = (id: PanelId): ReactNode => (
    <div className="dockleaf floatwin" key={id} data-dock-pe="1" style={floatStyle(layout[id] as Extract<Placement, { kind: 'float' }>)}>
      <div className="dockhead" onPointerDown={(e) => startDrag(id, e)} title="拖动以停靠">
        <span className="dh-grip">⠿</span>
        <span className="dh-title">{TITLE[id]}</span>
        <span className="dh-x" title="停靠回默认位置" onPointerDown={(e) => e.stopPropagation()} onClick={() => redock(id)}>×</span>
      </div>
      <div className="dockbody">{BODY[id]()}</div>
      <span className="float-resize" onPointerDown={(e) => startResize(id, e)} />
    </div>
  );

  const d = drag.current;
  const cols = `${left.length ? 'var(--dock-side)' : '0px'} 1fr ${right.length ? 'var(--dock-side)' : '0px'}`;
  const rows = `1fr ${bottom.length ? 'var(--dock-bottom)' : '0px'}`;

  return (
    <div className="dockspace" ref={dockRef} style={{ gridTemplateColumns: cols, gridTemplateRows: rows }}>
      <div className="dock-col dock-left">{regionLeaf('left', left)}</div>
      <div className="dock-center" />
      <div className="dock-col dock-right">{regionLeaf('right', right)}</div>
      <div className="dock-row dock-bottom">{regionLeaf('bottom', bottom)}</div>
      {floats.map((id) => floatLeaf(id))}

      {d && d.moved && (
        <div className="dropover">
          <div className={`dz l${d.zone === 'left' ? ' on' : ''}`} />
          <div className={`dz r${d.zone === 'right' ? ' on' : ''}`} />
          <div className={`dz b${d.zone === 'bottom' ? ' on' : ''}`} />
          <div className={`dz c${d.zone === 'float' ? ' on' : ''}`}>
            <span className="dzlabel">{d.zone === 'float' ? '松手 → 浮动窗' : `松手 → 停靠 ${d.zone}`}</span>
          </div>
          <div className="draggh" style={{ left: d.px - d.grabX, top: d.py - d.grabY }}>
            <div className="h">⠿ 拖动中：{TITLE[d.id]}</div>
            <div className="b">边缘 → 停靠 · 中心 → 浮动</div>
          </div>
        </div>
      )}
    </div>
  );
}

function floatStyle(p: Extract<Placement, { kind: 'float' }>): CSSProperties {
  return { left: p.x, top: p.y, width: p.w, height: p.h };
}
