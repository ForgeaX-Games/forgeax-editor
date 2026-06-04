import { useEffect, useReducer, useRef } from 'react';
import type { CSSProperties, PointerEvent as RPointerEvent, ReactNode } from 'react';
import { HierarchyPanel } from './Hierarchy';
import { InspectorPanel } from './Inspector';
import { AssetsPanel } from './Assets';
import { HistoryPanel } from './History';
import { CapabilitiesPanel } from './Capabilities';

// DockManager — the editor's window/docking shell (design EDITOR-MODE §21 + the
// §01/§02 mockup): panels are dock leaves you DRAG by their title; drop near a
// dock edge (left/right/bottom) to dock there, drop over the center to FLOAT a
// window (draggable / resizable / closeable, rounded). No float buttons — the
// drop location decides. Layout persists to localStorage (versioned). This is a
// custom lightweight take (dockview isn't installable here); the recursive split
// tree + OS-window pop-out (Tauri) remain future work.

type PanelId = 'hierarchy' | 'assets' | 'inspector' | 'history' | 'capabilities';
type Region = 'left' | 'right' | 'bottom';
type Zone = Region | 'float';
type Placement =
  | { kind: 'dock'; region: Region; order: number }
  | { kind: 'float'; x: number; y: number; w: number; h: number };
type Layout = Record<PanelId, Placement>;

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

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const o = JSON.parse(raw) as { v?: number; layout?: Layout };
      if (o.v === 3 && o.layout && ALL.every((id) => o.layout![id])) return o.layout;
    }
  } catch { /* corrupt → default */ }
  return { ...DEFAULT_LAYOUT };
}
function saveLayout(layout: Layout): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ v: 3, layout })); } catch { /* quota */ }
}

// Single mutable layout + a forceUpdate; drag uses refs to avoid stale closures.
export function DockManager() {
  const layoutRef = useRef<Layout>(loadLayout());
  const [, force] = useReducer((n: number) => n + 1, 0);
  const dockRef = useRef<HTMLDivElement | null>(null);
  // transient drag state (not React state — updated at pointer rate).
  const drag = useRef<{ id: PanelId; grabX: number; grabY: number; px: number; py: number; zone: Zone } | null>(null);
  const [, forceDrag] = useReducer((n: number) => n + 1, 0);

  const commit = (next: Layout): void => { layoutRef.current = next; saveLayout(next); force(); };

  function zoneAt(px: number, py: number): Zone {
    const r = dockRef.current?.getBoundingClientRect();
    if (!r) return 'float';
    const fx = (px - r.left) / r.width, fy = (py - r.top) / r.height;
    if (fx < 0.16) return 'left';
    if (fx > 0.84) return 'right';
    if (fy > 0.80) return 'bottom';
    return 'float'; // center
  }

  function nextOrder(layout: Layout, region: Region): number {
    let m = -1;
    for (const id of ALL) { const p = layout[id]; if (p.kind === 'dock' && p.region === region) m = Math.max(m, p.order); }
    return m + 1;
  }

  // ── drag a panel by its title ──
  function startDrag(id: PanelId, e: RPointerEvent): void {
    e.preventDefault();
    const p = layoutRef.current[id];
    const fx = p.kind === 'float' ? e.clientX - p.x : 12;
    const fy = p.kind === 'float' ? e.clientY - p.y : 12;
    drag.current = { id, grabX: fx, grabY: fy, px: e.clientX, py: e.clientY, zone: zoneAt(e.clientX, e.clientY) };
    forceDrag();
  }

  useEffect(() => {
    function onMove(e: PointerEvent): void {
      const d = drag.current;
      if (!d) return;
      d.px = e.clientX; d.py = e.clientY;
      // a floating window follows the cursor live; docked drag only shows the ghost.
      const cur = layoutRef.current[d.id];
      if (cur.kind === 'float') {
        layoutRef.current = { ...layoutRef.current, [d.id]: { ...cur, x: e.clientX - d.grabX, y: e.clientY - d.grabY } };
      }
      d.zone = zoneAt(e.clientX, e.clientY);
      forceDrag();
    }
    function onUp(e: PointerEvent): void {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      const zone = zoneAt(e.clientX, e.clientY);
      const layout = { ...layoutRef.current };
      if (zone === 'float') {
        const prev = layout[d.id];
        if (prev.kind === 'float') layout[d.id] = { ...prev, x: e.clientX - d.grabX, y: e.clientY - d.grabY };
        else layout[d.id] = { kind: 'float', x: Math.max(8, e.clientX - 120), y: Math.max(40, e.clientY - 14), w: 260, h: 340 };
      } else {
        layout[d.id] = { kind: 'dock', region: zone, order: nextOrder(layout, zone) };
      }
      commit(layout);
      forceDrag();
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
  }, []);

  // ── resize a floating window (bottom-right handle) ──
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

  const leaf = (id: PanelId, floating: boolean) => (
    <div className={`dockleaf${floating ? ' floatwin' : ''}`} key={id} data-dock-pe="1"
      style={floating ? floatStyle(layout[id] as Extract<Placement, { kind: 'float' }>) : undefined}>
      <div className="dockhead" onPointerDown={(e) => startDrag(id, e)} title="拖动以浮动 / 停靠">
        <span className="dh-grip">⠿</span>
        <span className="dh-title">{TITLE[id]}</span>
        {floating && <span className="dh-x" title="停靠回默认位置" onPointerDown={(e) => e.stopPropagation()} onClick={() => redock(id)}>×</span>}
      </div>
      <div className="dockbody">{BODY[id]()}</div>
      {floating && <span className="float-resize" onPointerDown={(e) => startResize(id, e)} />}
    </div>
  );

  const d = drag.current;
  const cols = `${left.length ? 'var(--dock-side)' : '0px'} 1fr ${right.length ? 'var(--dock-side)' : '0px'}`;
  const rows = `1fr ${bottom.length ? 'var(--dock-bottom)' : '0px'}`;

  return (
    <div className="dockspace" ref={dockRef} style={{ gridTemplateColumns: cols, gridTemplateRows: rows }}>
      <div className="dock-col dock-left">{left.map((id) => leaf(id, false))}</div>
      <div className="dock-center" />
      <div className="dock-col dock-right">{right.map((id) => leaf(id, false))}</div>
      <div className="dock-row dock-bottom">{bottom.map((id) => leaf(id, false))}</div>
      {floats.map((id) => leaf(id, true))}

      {d && (
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
