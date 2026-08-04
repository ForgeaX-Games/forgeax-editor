/**
 * DrawerHostView — the host view for `kind:'drawer'` locations (ADR-0030 §2.3).
 *
 * Renders ONLY the expandable panel overlay. The launcher tab lives IN the
 * status bar (a strip contribution — see DrawerLauncher / chrome-drawer.tsx),
 * so the footer stays a SINGLE row: clicking a launcher tab expands its panel
 * UPWARD as an overlay that slides in over the workspace (single-active).
 *
 * Geometry (ADR-0030 §1 drawer capabilities): left edge = screen left, right
 * edge = flush against the plugin rail (`.activity-rail`, measured at runtime),
 * bottom = just above the status bar. Height persists via useDrawerStore.
 *
 * Data planes stay separate (ADR-0030 §4): structural = drawerPanels snapshot;
 * UI layout = useDrawerStore (open/active/height); business = each panel's own
 * store. A panel unregistered while active collapses gracefully (no dangling).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { PanelBottomClose } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { usePanelRenderers } from '../DockShell/panelRenderers';
import { RecoveryBoundary } from '../ErrorBoundary';
import type { DrawerPanelContribution } from '../../core/panels';
import { useDrawerStore } from './useDrawerStore';
import './DrawerHostView.css';

const RESIZING_CLASS = 'fx-drawer-resizing';

export function DrawerHostView(): ReactElement | null {
  const { t } = useTranslation();
  const renderers = usePanelRenderers();
  const activeId = useDrawerStore((s) => s.activeId);
  const height = useDrawerStore((s) => s.height);
  const close = useDrawerStore((s) => s.close);
  const setHeight = useDrawerStore((s) => s.setHeight);

  const panels = useMemo<DrawerPanelContribution[]>(() => {
    const list = Object.values(renderers.drawerPanels ?? {});
    return list
      .filter((p) => !p.when || p.when())
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [renderers.drawerPanels]);

  const active = activeId ? panels.find((p) => p.id === activeId) ?? null : null;

  // Exit animation: when activeId clears we keep the last panel mounted with an
  // `is-closing` class (reverse reveal) and unmount on animationend, so collapse
  // animates instead of vanishing. Panel→panel switches swap immediately.
  const [displayPanel, setDisplayPanel] = useState<DrawerPanelContribution | null>(active);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (active) { setDisplayPanel(active); setClosing(false); }
    else if (displayPanel) { setClosing(true); }
  }, [active, displayPanel]);

  // Graceful degrade (ADR-0030 §6): the active panel was unregistered → collapse.
  useEffect(() => {
    if (activeId && !panels.some((p) => p.id === activeId)) close();
  }, [activeId, panels, close]);

  // Right edge flush against the plugin rail — measured (chat column width is
  // user-resizable, so a static inset would drift).
  const [rightInset, setRightInset] = useState(0);
  useEffect(() => {
    const measure = () => {
      const rail = document.querySelector('.activity-rail');
      if (!rail) { setRightInset(0); return; }
      const rect = rail.getBoundingClientRect();
      setRightInset(Math.max(0, Math.round(window.innerWidth - rect.left)));
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(document.body);
    return () => { window.removeEventListener('resize', measure); ro?.disconnect(); };
  }, []);

  // Top-edge resize (pointer capture — mirrors AuxBarResizer so a drag that
  // leaves the 6px handle still tracks; body class locks the engine iframe).
  const startYRef = useRef(0);
  const startHRef = useRef(0);
  const onResizeDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    startYRef.current = e.clientY;
    startHRef.current = useDrawerStore.getState().height;
    document.body.classList.add(RESIZING_CLASS);
  }, []);
  const onResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    // Handle is on the TOP edge → moving pointer UP (delta positive) grows it.
    setHeight(startHRef.current + (startYRef.current - e.clientY));
  }, [setHeight]);
  const onResizeUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    document.body.classList.remove(RESIZING_CLASS);
  }, []);

  if (!displayPanel) return null;

  return (
    <div
      className={`fx-drawer-panel${closing ? ' is-closing' : ''}`}
      data-fx-slot="Drawer"
      style={{ height, ['--fx-drawer-right' as string]: `${rightInset}px` }}
      onAnimationEnd={() => {
        if (closing) { setDisplayPanel(null); setClosing(false); }
      }}
    >
      <div
        className="fx-drawer-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize drawer"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
      />
      <div className="fx-drawer-header">
        <span className="fx-drawer-title">
          {displayPanel.titleKey ? t(displayPanel.titleKey) : displayPanel.title}
        </span>
        <button
          type="button"
          className="fx-drawer-collapse"
          onClick={close}
          title="Collapse"
          aria-label="Collapse drawer"
        >
          <PanelBottomClose size={14} />
        </button>
      </div>
      <div className="fx-drawer-body">
        <RecoveryBoundary scope={`drawer:${displayPanel.id}`} fullscreen={false}>
          {displayPanel.render()}
        </RecoveryBoundary>
      </div>
    </div>
  );
}
