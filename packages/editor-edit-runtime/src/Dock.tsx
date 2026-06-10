import { useEffect, useReducer, useRef } from 'react';
import type { PointerEvent as RPointerEvent, ReactNode } from 'react';
import { HierarchyPanel } from './Hierarchy';
import { InspectorPanel } from './Inspector';
import { AssetsPanel } from './Assets';
import { HistoryPanel } from './History';
import { CapabilitiesPanel } from './Capabilities';
import { MaterialPanel } from './Material';
import { TimelinePanel } from './Timeline';
import { MaterialGraphPanel } from './MaterialGraph';
import { getSceneId, onPopoutClosed, onPopoutGeom } from './store';
import type { PopoutGeom } from '@forgeax/editor-core';
import {
  type DockNode, type SplitNode, type TabsNode, type DropSide,
  tabs, split, movePanel, removePanel, setSizes, setActivePanel,
  firstLeaf, reconcile,
} from './dock-tree';

// DockManager — the editor's window/docking shell (design EDITOR-MODE §0.2.1):
// a RECURSIVE Split(row/col)+TabGroup tree (see dock-tree.ts) you reshape by
// dragging a panel's tab — drop on a leaf's CENTER to tab it, on an EDGE to split
// (arbitrary nesting), on the TOP strip to POP OUT to an OS window. Splits have
// draggable 1px separators. The Viewport is itself a leaf (transparent, click-
// through to the engine canvas) so it tiles + splits like any panel. Panels can
// also FLOAT (⤢) as in-window windows or POP OUT (⤤) to a real OS window
// (design §0.2.2). Tree + floats persist to localStorage (v4); popout is transient.

type PanelId = 'viewport' | 'hierarchy' | 'assets' | 'inspector' | 'history' | 'capabilities' | 'material' | 'timeline' | 'matgraph';
interface FloatRect { x: number; y: number; w: number; h: number }

const TITLE: Record<PanelId, string> = {
  viewport: 'Viewport', hierarchy: 'Hierarchy', assets: 'Assets', inspector: 'Inspector', history: 'History', capabilities: 'Capabilities', material: 'Material', timeline: 'Timeline', matgraph: 'Mat Graph',
};
const BODY: Record<PanelId, () => ReactNode> = {
  viewport: () => null, // transparent — the engine canvas shows through
  hierarchy: () => <HierarchyPanel />,
  assets: () => <AssetsPanel />,
  inspector: () => <InspectorPanel />,
  history: () => <HistoryPanel />,
  capabilities: () => <CapabilitiesPanel />,
  material: () => <MaterialPanel />,
  timeline: () => <TimelinePanel />,
  matgraph: () => <MaterialGraphPanel />,
};
// Every panel that can live in the dock tree (viewport included).
const DOCK_PANELS: PanelId[] = ['viewport', 'hierarchy', 'assets', 'inspector', 'history', 'capabilities', 'material', 'timeline', 'matgraph'];
// Panels that can float / pop out (viewport stays put).
const POPPABLE = new Set<PanelId>(['hierarchy', 'assets', 'inspector', 'history', 'capabilities', 'material', 'timeline', 'matgraph']);

function defaultTree(): DockNode {
  return split('row', [
    tabs(['hierarchy', 'assets']),
    split('col', [tabs(['viewport']), tabs(['timeline', 'history', 'capabilities'])], [0.7, 0.3]),
    tabs(['inspector', 'material', 'matgraph']),
  ], [0.2, 0.6, 0.2]);
}

const LS_KEY = 'forgeax:editor:layout:v5';
interface Saved { v: number; tree: DockNode; floats?: Record<string, FloatRect> }
function loadSaved(): { tree: DockNode; floats: Map<PanelId, FloatRect> } {
  let tree: DockNode | null = null;
  const floats = new Map<PanelId, FloatRect>();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const o = JSON.parse(raw) as Saved;
      if (o.v === 5 && o.tree) tree = o.tree;
      if (o.floats) for (const [k, r] of Object.entries(o.floats)) if (POPPABLE.has(k as PanelId)) floats.set(k as PanelId, r);
    }
  } catch { /* corrupt → default */ }
  // reconcile against the authoritative panel set, minus whatever is floating
  // (a floating panel must not also live in the tree). With NO saved tree we must
  // start from defaultTree() — reconcile(null, …) would dump every panel into a
  // single tab group (the "everything in one tab, no float buttons" bug).
  const docked = DOCK_PANELS.filter((p) => !floats.has(p));
  return { tree: reconcile(tree ?? defaultTree(), docked), floats };
}

// Pop-out window geometry memory (design §0.2.3), keyed per scene+panel.
const LS_GEOM = 'forgeax:editor:popout-geom';
function geomKey(panel: PanelId): string { return `${LS_GEOM}:${getSceneId()}:${panel}`; }
function loadGeom(panel: PanelId): PopoutGeom | null {
  try {
    const raw = localStorage.getItem(geomKey(panel));
    if (!raw) return null;
    const g = JSON.parse(raw) as Partial<PopoutGeom>;
    if (typeof g.w === 'number' && typeof g.h === 'number' && g.w > 0 && g.h > 0) {
      return { w: g.w, h: g.h, x: typeof g.x === 'number' ? g.x : 0, y: typeof g.y === 'number' ? g.y : 0 };
    }
  } catch { /* corrupt → ignore */ }
  return null;
}
function saveGeom(panel: PanelId, geom: PopoutGeom): void {
  try { localStorage.setItem(geomKey(panel), JSON.stringify(geom)); } catch { /* quota */ }
}

function findSplit(n: DockNode, id: string): SplitNode | null {
  if (n.kind === 'tabs') return null;
  if (n.id === id) return n;
  for (const c of n.children) { const r = findSplit(c, id); if (r) return r; }
  return null;
}

interface DragState {
  panel: PanelId;
  from: 'tab' | 'float';
  grabX: number; grabY: number;
  px: number; py: number; sx: number; sy: number;
  moved: boolean;
  target: { leafId: string; side: DropSide; rect: FloatRect } | 'popout' | null;
}

export function DockManager() {
  const init = loadSaved();
  const treeRef = useRef<DockNode>(init.tree);
  const floatsRef = useRef<Map<PanelId, FloatRect>>(init.floats);
  const poppedRef = useRef<Set<PanelId>>(new Set());
  const dockRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<DragState | null>(null);
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [, forceDrag] = useReducer((n: number) => n + 1, 0);

  const save = (): void => {
    try {
      const floats: Record<string, FloatRect> = {};
      for (const [k, r] of floatsRef.current) floats[k] = r;
      localStorage.setItem(LS_KEY, JSON.stringify({ v: 5, tree: treeRef.current, floats } satisfies Saved));
    } catch { /* quota */ }
  };
  const commitTree = (next: DockNode): void => { treeRef.current = next; save(); force(); };

  // ── reshape ops ──────────────────────────────────────────────────────────
  const floatPanel = (panel: PanelId): void => {
    if (!POPPABLE.has(panel)) return;
    const r = removePanel(treeRef.current, panel); if (r) treeRef.current = r;
    const dr = dockRef.current?.getBoundingClientRect();
    const cx = dr ? dr.width / 2 - 140 : 80, cy = dr ? dr.height / 2 - 170 : 60;
    floatsRef.current.set(panel, { x: Math.max(8, cx), y: Math.max(8, cy), w: 280, h: 340 });
    save(); force();
  };
  const dockBack = (panel: PanelId): void => {
    const f = firstLeaf(treeRef.current);
    treeRef.current = f ? movePanel(treeRef.current, panel, f.id, 'center') : tabs([panel]);
  };
  const popOut = (panel: PanelId): void => {
    if (!POPPABLE.has(panel)) return;
    poppedRef.current.add(panel);
    const r = removePanel(treeRef.current, panel); if (r) treeRef.current = r;
    floatsRef.current.delete(panel);
    const geom = loadGeom(panel);
    try { window.parent?.postMessage({ type: 'VAG_EDITOR_POPOUT', payload: { panel, scene: getSceneId(), title: TITLE[panel], geom } }, '*'); }
    catch { /* cross-origin */ }
    save(); force();
  };
  const redockFromPopout = (panel: PanelId): void => {
    if (!poppedRef.current.delete(panel)) return;
    dockBack(panel); save(); force();
  };
  const closePopout = (panel: PanelId): void => {
    try { window.parent?.postMessage({ type: 'VAG_EDITOR_REDOCK', payload: { panel } }, '*'); }
    catch { /* cross-origin */ }
    redockFromPopout(panel);
  };
  const redockFloat = (panel: PanelId): void => {
    if (!floatsRef.current.delete(panel)) return;
    dockBack(panel); save(); force();
  };

  // ── tab / float drag ───────────────────────────────────────────────────────
  function startDrag(panel: PanelId, from: 'tab' | 'float', e: RPointerEvent): void {
    e.preventDefault();
    const fr = from === 'float' ? floatsRef.current.get(panel) : undefined;
    drag.current = {
      panel, from,
      grabX: fr ? e.clientX - fr.x : 12, grabY: fr ? e.clientY - fr.y : 12,
      px: e.clientX, py: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, target: null,
    };
    forceDrag();
  }

  function computeTarget(panel: PanelId, px: number, py: number): DragState['target'] {
    const root = dockRef.current;
    if (!root) return null;
    const dr = root.getBoundingClientRect();
    if (POPPABLE.has(panel) && py >= dr.top && py - dr.top < 30) return 'popout';
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-leaf-id]'))) {
      const r = el.getBoundingClientRect();
      if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
        const fx = (px - r.left) / r.width, fy = (py - r.top) / r.height;
        const side: DropSide = fx < 0.22 ? 'left' : fx > 0.78 ? 'right' : fy < 0.22 ? 'top' : fy > 0.78 ? 'bottom' : 'center';
        return { leafId: el.dataset.leafId!, side, rect: { x: r.left - dr.left, y: r.top - dr.top, w: r.width, h: r.height } };
      }
    }
    return null;
  }

  useEffect(() => {
    function onMove(e: PointerEvent): void {
      const d = drag.current;
      if (!d) return;
      d.px = e.clientX; d.py = e.clientY;
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) d.moved = true;
      if (d.from === 'float' && d.moved) {
        const fr = floatsRef.current.get(d.panel);
        if (fr) { fr.x = e.clientX - d.grabX; fr.y = e.clientY - d.grabY; }
      }
      if (d.moved) d.target = computeTarget(d.panel, e.clientX, e.clientY);
      forceDrag();
    }
    function onUp(): void {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      if (!d.moved) { forceDrag(); return; } // a click → tab switch via onClick
      const tgt = d.target;
      if (tgt === 'popout') { popOut(d.panel); forceDrag(); return; }
      if (tgt) {
        if (d.from === 'float') floatsRef.current.delete(d.panel);
        commitTree(movePanel(treeRef.current, d.panel, tgt.leafId, tgt.side));
      } else if (d.from === 'tab') {
        if (d.panel !== 'viewport') {
          const r = removePanel(treeRef.current, d.panel); if (r) treeRef.current = r;
          floatsRef.current.set(d.panel, { x: Math.max(8, d.px - 140), y: Math.max(8, d.py - 14), w: 280, h: 340 });
          save(); force();
        }
      } else {
        save(); // float just moved
      }
      forceDrag();
    }
    function onReset(): void {
      treeRef.current = defaultTree();
      floatsRef.current.clear();
      save(); force();
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('forgeax:editor:dock-reset', onReset as EventListener);
    const offClosed = onPopoutClosed((p) => redockFromPopout(p as PanelId));
    const offGeom = onPopoutGeom((p, g) => saveGeom(p as PanelId, g));
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('forgeax:editor:dock-reset', onReset as EventListener);
      offClosed();
      offGeom();
    };
  }, []);

  // ── split resize ────────────────────────────────────────────────────────────
  function startResize(splitId: string, index: number, e: RPointerEvent): void {
    e.preventDefault(); e.stopPropagation();
    const node = findSplit(treeRef.current, splitId);
    const container = (e.currentTarget as HTMLElement).parentElement;
    if (!node || !container) return;
    const rect = container.getBoundingClientRect();
    const horiz = node.dir === 'row';
    const total = (horiz ? rect.width : rect.height) || 1;
    const s0 = [...node.sizes];
    const sx = e.clientX, sy = e.clientY;
    function mv(ev: PointerEvent): void {
      const delta = (horiz ? ev.clientX - sx : ev.clientY - sy) / total;
      const a = s0[index]! + delta, b = s0[index + 1]! - delta;
      if (a < 0.05 || b < 0.05) return;
      const sizes = [...s0]; sizes[index] = a; sizes[index + 1] = b;
      treeRef.current = setSizes(treeRef.current, splitId, sizes); force();
    }
    function up(): void { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); save(); }
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  }

  // ── render ────────────────────────────────────────────────────────────────
  const renderLeaf = (leaf: TabsNode): ReactNode => {
    const active = (leaf.panels[leaf.active] ?? leaf.panels[0]) as PanelId | undefined;
    if (!active) return null;
    const isVp = active === 'viewport';
    return (
      <div className={`dockleaf${isVp ? ' leaf-viewport' : ''}`} data-leaf-id={leaf.id} key={leaf.id}>
        <div className="docktabs">
          {leaf.panels.map((p) => (
            <div key={p} className={`docktab${p === active ? ' on' : ''}`} title="拖动→停靠/分割/弹出;单击切换"
              onPointerDown={(e) => startDrag(p as PanelId, 'tab', e)} onClick={() => commitTree(setActivePanel(treeRef.current, leaf.id, p))}>
              <span className="dh-grip">⠿</span>{TITLE[p as PanelId]}
            </div>
          ))}
          <span className="docktabs-sp" />
          {active !== 'viewport' && (
            <>
              <span className="dt-act" title="浮动为窗口" onPointerDown={(e) => e.stopPropagation()} onClick={() => floatPanel(active)}>⤢</span>
              <span className="dt-act" title="弹出为独立窗口" onPointerDown={(e) => e.stopPropagation()} onClick={() => popOut(active)}>⤤</span>
            </>
          )}
        </div>
        <div className="dockbody">{BODY[active]()}</div>
      </div>
    );
  };
  const renderSplit = (s: SplitNode): ReactNode => {
    const kids: ReactNode[] = [];
    s.children.forEach((c, i) => {
      kids.push(<div className="dock-pane" key={c.id} style={{ flex: `${s.sizes[i] ?? 1 / s.children.length} 1 0px` }}>{renderNode(c)}</div>);
      if (i < s.children.length - 1) kids.push(<div key={`sep${i}`} className={`dock-sep ${s.dir}`} onPointerDown={(e) => startResize(s.id, i, e)} />);
    });
    return <div className={`dock-split ${s.dir}`} key={s.id}>{kids}</div>;
  };
  function renderNode(n: DockNode): ReactNode { return n.kind === 'split' ? renderSplit(n) : renderLeaf(n); }

  const floatLeaf = (panel: PanelId, fr: FloatRect): ReactNode => (
    <div className="dockleaf floatwin" key={`f${panel}`} style={{ left: fr.x, top: fr.y, width: fr.w, height: fr.h }}>
      <div className="dockhead" onPointerDown={(e) => startDrag(panel, 'float', e)} title="拖动以停靠">
        <span className="dh-grip">⠿</span>
        <span className="dh-title">{TITLE[panel]}</span>
        <span className="dh-pop" title="弹出为独立窗口" onPointerDown={(e) => e.stopPropagation()} onClick={() => popOut(panel)}>⤤</span>
        <span className="dh-x" title="停靠回主窗" onPointerDown={(e) => e.stopPropagation()} onClick={() => redockFloat(panel)}>×</span>
      </div>
      <div className="dockbody">{BODY[panel]()}</div>
      <span className="float-resize" onPointerDown={(e) => startFloatResize(panel, e)} />
    </div>
  );
  function startFloatResize(panel: PanelId, e: RPointerEvent): void {
    e.preventDefault(); e.stopPropagation();
    const fr = floatsRef.current.get(panel);
    if (!fr) return;
    const sx = e.clientX, sy = e.clientY, sw = fr.w, sh = fr.h;
    function mv(ev: PointerEvent): void {
      const f = floatsRef.current.get(panel); if (!f) return;
      f.w = Math.max(180, sw + ev.clientX - sx); f.h = Math.max(140, sh + ev.clientY - sy);
      forceDrag();
    }
    function up(): void { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); save(); }
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  }

  const popped = DOCK_PANELS.filter((p) => poppedRef.current.has(p));
  const d = drag.current;

  return (
    <div className="dockspace" ref={dockRef}>
      <div className="dock-root">{renderNode(treeRef.current)}</div>
      {[...floatsRef.current.entries()].map(([p, fr]) => floatLeaf(p, fr))}

      {popped.length > 0 && (
        <div className="popout-tray" title="已弹出为独立窗口的面板">
          <span className="pt-tag">⤤ 独立窗口</span>
          {popped.map((id) => (
            <button key={id} type="button" className="pt-chip" title="停靠回主窗" onClick={() => closePopout(id)}>
              {TITLE[id]} <span className="pt-chip-x">⊟</span>
            </button>
          ))}
        </div>
      )}

      {d && d.moved && d.target === 'popout' && (
        <div className="dropind popout-band"><span className="dzlabel">松手 → 弹出独立窗口</span></div>
      )}
      {d && d.moved && d.target && d.target !== 'popout' && (
        <div className="dropind" style={{ left: d.target.rect.x, top: d.target.rect.y, width: d.target.rect.w, height: d.target.rect.h }}>
          <div className={`di-zone ${d.target.side}`}>
            <span className="dzlabel">{d.target.side === 'center' ? '并入 tab' : `分割 ${d.target.side}`}</span>
          </div>
        </div>
      )}
      {d && d.moved && (
        <div className="draggh" style={{ left: d.px - d.grabX, top: d.py - d.grabY }}>
          <div className="h">⠿ {TITLE[d.panel]}</div>
          <div className="b">边缘→分割 · 中心→并 tab · 顶部→弹出</div>
        </div>
      )}
    </div>
  );
}
