// Drawer-style expansion for dockview edge groups (the collapsible side menu
// bar). dockview 6.6.1 ships edge groups but their only expand mode is
// "restore to last size", which grows the splitview cell and PUSHES the
// neighbouring content — a layout shift. The overlay / auto-hide mode we want
// (VS-style: click a tab → panel slides out as an overlay ON TOP of the
// content, click outside → dismiss) is upstream feature request mathuo/dockview
// #1283 / PR #1295, still unmerged and unreleased.
//
// Until that lands we implement the exact same semantics in the app layer while
// keeping the edge group PERMANENTLY collapsed (its splitview cell never grows,
// so the grid layout NEVER shifts):
//   1. Intercept the tab `click` in the CAPTURE phase and preventDefault it, so
//      dockview's own onTabClick handler (which starts with
//      `if (event.defaultPrevented) return`) never runs its expand/resize.
//   2. Drive the active panel + drawer ourselves: setActive on the clicked
//      panel (no resize), then render the group's `.dv-content-container` as a
//      `position: fixed` flyout anchored to the strip's inner edge (see
//      DockShell.css `.fx-edge-drawer-open`).
//   3. Click outside / re-click active tab dismisses — with UE-style pin rules
//      (see step 5).
//   4. Because the drawer floats (no splitview sash), dockview's native
//      drag-to-resize is gone; we re-add it with our own grip on the drawer's
//      outer edge that only rewrites the drawer size var (never the grid).
//   5. Edge tabs show a per-TAB Pin toggle instead of dockview's close (X)
//      (UE): at most one pinned tab per edge group (mutual exclusion). A pinned
//      active tab ignores auto-dismiss; a non-pinned tab still auto-dismisses,
//      but if the group has a pin that dismiss snaps back to the pinned tab
//      instead of closing the drawer. This module owns only the STATE
//      (edgePinStore) and the capture-phase click that flips it — DockTab
//      renders the glyph off `api.location`, so there is no DOM swap to race
//      React's portal commit and nothing to undo when a panel leaves the strip.
//
// When #1295 ships this whole module can be replaced by the native `pinned`
// flag on EdgeGroupOptions.
import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from 'dockview';
import { FOOTER_PANEL_ID_LIST } from './builtinWorkbenches';
import { clearEdgePins, EDGE_PIN_CLASS, pinnedPanelIdIn, setEdgePin } from './edgePinStore';

const OPEN_CLASS = 'fx-edge-drawer-open';
/** Toggled to (re)start the wipe-in animation — on first open AND on same-strip tab switch. */
const ANIM_CLASS = 'fx-edge-drawer-animating';
const EDGE_POSITIONS = ['left', 'right', 'top', 'bottom'] as const;
type EdgePosition = (typeof EDGE_POSITIONS)[number];
/** Slots always registered so root-edge drop / "Move to Side" work even when
 *  the default layout keeps panels in the grid (no edgeGroups in JSON). */
const ENSURED_EDGE_SLOTS = ['left', 'right', 'bottom'] as const;

/** All edge groups, including EMPTY ones (zero panels). Must walk `api.groups`
 *  — collecting via panels misses strips whose last tab was closed, which is
 *  exactly when we need to hide them. */
function edgeGroups(api: DockviewApi): DockviewGroupPanel[] {
  return api.groups.filter((group) => group.api.location.type === 'edge');
}

/** The edge group whose element contains `el`, if any. */
function edgeGroupFromElement(api: DockviewApi, el: Element): DockviewGroupPanel | undefined {
  return edgeGroups(api).find((group) => group.element.contains(el));
}

/**
 * Install the drawer behaviour for every edge group under `root`. Returns a
 * disposer that removes all listeners and closes any open drawer. Idempotent to
 * call once per DockviewApi (wire it from DockRegion.onReady, push the disposer
 * into onReadyCleanupsRef).
 */
export function installEdgeDrawer(api: DockviewApi, root: HTMLElement): () => void {
  let openGroup: DockviewGroupPanel | null = null;

  // UE: pin is per-TAB, and at most ONE pin per edge group (mutual exclusion).
  // State lives in edgePinStore so DockTab can RENDER the toggle; this module
  // owns the rules and the click that flips it.
  const pinnedPanelId = (group: DockviewGroupPanel): string | undefined =>
    pinnedPanelIdIn(group.id);

  const findPanel = (group: DockviewGroupPanel, id: string): IDockviewPanel | undefined =>
    group.panels.find((p) => p.id === id);

  const activeIsPinned = (group: DockviewGroupPanel): boolean => {
    const active = group.activePanel;
    return !!active && pinnedPanelId(group) === active.id;
  };

  // Which edge the strip lives on decides which way the drawer grows and which
  // dimension the resize grip drags.
  type Edge = 'left' | 'right' | 'top' | 'bottom';
  const edgeOf = (group: DockviewGroupPanel): Edge => {
    const cl = group.element.classList;
    if (cl.contains('dv-groupview-header-right')) return 'right';
    if (cl.contains('dv-groupview-header-top')) return 'top';
    if (cl.contains('dv-groupview-header-bottom')) return 'bottom';
    return 'left';
  };
  const isHoriz = (e: Edge): boolean => e === 'left' || e === 'right';
  // The var that carries the user-dragged drawer size for a given edge.
  const sizeVar = (e: Edge): string =>
    isHoriz(e) ? '--fx-edge-drawer-width' : '--fx-edge-drawer-height';
  const readSize = (group: DockviewGroupPanel, e: Edge): number => {
    const n = parseFloat(group.element.style.getPropertyValue(sizeVar(e)));
    return Number.isFinite(n) ? n : 300;
  };

  // ── Bottom edge ↔ footer merge ──────────────────────────────────────────
  // The bottom edge strip is RELOCATED (DOM move) into the StatusBar footer
  // host so its tabs share the footer row with the status items. The move keeps
  // the real dockview tab element (native drag in/out, native drop targets),
  // so we only re-anchor the drawer + re-scope our own listeners. Left/right
  // strips stay in place under `root`.
  let bottomStripEl: HTMLElement | null = null;
  // Identity of the group whose strip is currently relocated. fromJSON /
  // rebuilds DISPOSE the bottom group and create a fresh one; the tracked
  // bottomStripEl then points at a detached (empty) strip. Comparing group ids
  // lets relocate tell "same group, already moved" (reuse bottomStripEl) from
  // "new group" (must grab the new group's live strip, never the stale one).
  let bottomGroupId: string | null = null;
  const footerHost = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-fx-dock-bottom-host]');
  // When a fresh bottom group exists but its header isn't built yet, relocate
  // bails; this bounded next-frame nudge re-tries until the strip is ready
  // (reset on any successful relocate) so we never stall on the stale strip.
  let relocateRaf = 0;
  let bailFrames = 0;
  const scheduleRelocate = (): void => {
    if (relocateRaf) return;
    relocateRaf = requestAnimationFrame(() => { relocateRaf = 0; relocateBottomStrip(); });
  };
  // The element that actually holds a group's `.dv-tab`s: the relocated footer
  // container for the bottom edge, else the group element itself.
  const tabsRootOf = (group: DockviewGroupPanel): HTMLElement =>
    edgeOf(group) === 'bottom' && bottomStripEl ? bottomStripEl : group.element;

  // ── Footer-anchored drop overlays for the relocated bottom strip ─────────
  // Each tab's Droptarget paints its receive-highlight / reorder line into
  // `group.model.dropTargetContainer` — by default `rootDropTargetContainer`,
  // anchored to the dockview shell element. Our bottom strip is relocated into
  // the footer (OUTSIDE the shell), so that anchor can't cover it: drags over
  // the footer tabs showed no highlight and reorder had no indicator. dockview
  // supports a PER-GROUP drop-target container (the same pattern it uses for
  // popout windows). Its `DropTargetAnchorContainer` class is internal /
  // unexported, so we hand the bottom group a shim with the exact
  // `{ disabled, model }` shape droptarget.ts consumes, mounting overlays into
  // a viewport-fixed host so `renderAnchoredOverlay` positions them at the
  // footer tabs' real coordinates.
  let dropAnchorHost: HTMLElement | null = null;
  let dropAnchorModel: { root: HTMLElement; overlay: HTMLElement; changed: boolean } | undefined;
  const ensureDropAnchorHost = (): HTMLElement => {
    if (dropAnchorHost) return dropAnchorHost;
    const host = document.createElement('div');
    host.className = 'fx-edge-drop-anchor-host';
    document.body.appendChild(host);
    dropAnchorHost = host;
    return host;
  };
  // Force-remove any live footer drop overlay. dockview only calls the shim's
  // clear() when the bottom group is the ACTUAL drop target; dragging a bottom
  // tab OUT to another group drops elsewhere, so the bottom tab's droptarget
  // only sees dragleave (which, with an override target, intentionally does NOT
  // clear) — leaving a stale lime rectangle in the footer. Driven by the global
  // dragover watcher below (during the drag) and the dragend/drop backstop.
  const clearDropAnchor = (): void => {
    if (!dropAnchorModel) return;
    try { dropAnchorModel.root.parentElement?.removeChild(dropAnchorModel.root); } catch { /* noop */ }
    dropAnchorModel = undefined;
  };
  const bottomDropContainer = {
    get disabled(): boolean { return false; },
    set disabled(_v: boolean) { /* always enabled — the footer strip needs it */ },
    get model() {
      const host = ensureDropAnchorHost();
      return {
        clear: (): void => {
          dropAnchorModel?.root.parentElement?.removeChild(dropAnchorModel.root);
          dropAnchorModel = undefined;
        },
        exists: (): boolean => !!dropAnchorModel,
        getElements: () => {
          if (dropAnchorModel) { dropAnchorModel.changed = false; return dropAnchorModel; }
          const root = document.createElement('div');
          root.className = 'dv-drop-target-container';
          const overlay = document.createElement('div');
          overlay.className = 'dv-drop-target-anchor';
          overlay.style.visibility = 'hidden';
          root.appendChild(overlay);
          host.appendChild(root);
          dropAnchorModel = { root, overlay, changed: true };
          return dropAnchorModel;
        },
      };
    },
    dispose: (): void => {
      dropAnchorHost?.remove();
      dropAnchorHost = null;
      dropAnchorModel = undefined;
    },
  };
  const attachBottomDropContainer = (group: DockviewGroupPanel): void => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const model = (group as any).model;
      if (model && model.dropTargetContainer !== bottomDropContainer) {
        model.dropTargetContainer = bottomDropContainer;
      }
    } catch { /* dockview internals moved — footer drop keeps working sans overlay */ }
  };

  // Our own resize handle — a thin fixed bar riding the drawer's far edge. Native
  // dockview resize is a splitview sash that would push the grid, which we forbid;
  // dragging this grip only rewrites the CSS size var, so the overlay grows/shrinks
  // without ever touching the collapsed splitview cell. One grip is reused for the
  // single drawer that can be open at a time; it lives INSIDE openGroup.element so
  // the outside-click dismiss (which checks group.element.contains) ignores it.
  const grip = document.createElement('div');
  grip.className = 'fx-edge-drawer-grip';

  // Anchor the fixed flyout to the strip's inner edge. Left/right strips grow
  // horizontally (drawer to the strip's right/left); top/bottom grow vertically.
  const position = (group: DockviewGroupPanel): void => {
    const s = group.element.style;
    // Bottom edge is footer-merged: the strip lives in the StatusBar, so anchor
    // the drawer to span the content column (group.element still reports that
    // width) and rise UP from the footer's top edge — not from the collapsed
    // splitview cell.
    if (edgeOf(group) === 'bottom') {
      const gr = group.element.getBoundingClientRect();
      const footer = footerHost()?.closest('.global-status-bar');
      const footerTop = footer ? footer.getBoundingClientRect().top : window.innerHeight;
      s.setProperty('--fx-edge-strip-left', `${gr.left}px`);
      s.setProperty('--fx-edge-strip-width', `${gr.width}px`);
      s.setProperty('--fx-edge-drawer-bottom', `${window.innerHeight - footerTop}px`);
      positionGrip(group);
      return;
    }
    const r = group.element.getBoundingClientRect();
    s.setProperty('--fx-edge-drawer-left', `${r.right}px`);
    s.setProperty('--fx-edge-drawer-right', `${window.innerWidth - r.left}px`);
    s.setProperty('--fx-edge-drawer-top', `${r.bottom}px`);
    s.setProperty('--fx-edge-drawer-bottom', `${window.innerHeight - r.top}px`);
    s.setProperty('--fx-edge-strip-top', `${r.top}px`);
    s.setProperty('--fx-edge-strip-left', `${r.left}px`);
    s.setProperty('--fx-edge-strip-height', `${r.height}px`);
    s.setProperty('--fx-edge-strip-width', `${r.width}px`);
    positionGrip(group);
  };

  // Park the grip on the drawer's outer edge (the edge away from the strip),
  // spanning the drawer's cross axis. Tracks the live strip rect + size var.
  const positionGrip = (group: DockviewGroupPanel): void => {
    const e = edgeOf(group);
    const r = group.element.getBoundingClientRect();
    const size = readSize(group, e);
    const g = grip.style;
    g.position = 'fixed';
    // Match the drawer's cross-axis inset (DockShell.css --fx-edge-drawer-inset)
    // so the resize grip rides the flyout's edge, not the full strip span.
    const INSET = 6;
    if (e === 'left') {
      g.top = `${r.top + INSET}px`; g.height = `${r.height - 2 * INSET}px`;
      g.left = `${r.right + size - 3}px`; g.width = '6px'; g.cursor = 'ew-resize';
    } else if (e === 'right') {
      g.top = `${r.top + INSET}px`; g.height = `${r.height - 2 * INSET}px`;
      g.left = `${r.left - size - 3}px`; g.width = '6px'; g.cursor = 'ew-resize';
    } else if (e === 'top') {
      g.left = `${r.left + INSET}px`; g.width = `${r.width - 2 * INSET}px`;
      g.top = `${r.bottom + size - 3}px`; g.height = '6px'; g.cursor = 'ns-resize';
    } else {
      g.left = `${r.left + INSET}px`; g.width = `${r.width - 2 * INSET}px`;
      g.top = `${r.top - size - 3}px`; g.height = '6px'; g.cursor = 'ns-resize';
    }
  };

  // Restart the wipe-in keyframes. CSS `animation` only fires when the animating
  // class is (re)applied — keeping OPEN_CLASS alone on a same-strip tab switch
  // would leave the drawer static (UE re-animates the panel on every mode click).
  const kickAnim = (group: DockviewGroupPanel): void => {
    const el = group.element;
    el.classList.remove(ANIM_CLASS);
    // Force a style recalc so the next add is treated as a fresh animation start.
    void el.offsetWidth;
    el.classList.add(ANIM_CLASS);
  };

  // The bottom strip is relocated into the footer, OUTSIDE its group element, so
  // the OPEN_CLASS we add to group.element never reaches it. Mirror the open
  // state onto the footer strip so the active-tab highlight (dv-active-tab) only
  // shows WHILE the drawer is open — otherwise the group's always-present active
  // panel would paint a persistent highlight in the footer with no click.
  // The relocated footer strip is OUTSIDE its group element, so the
  // `dv-active-group` focus class dockview toggles never reaches it. Mirror it
  // as `fx-bottom-edge-focused` so the lime focus accent (::before) lights ONLY
  // while the bottom drawer is BOTH open AND focused — not merely open (an open
  // but unfocused drawer keeps its selected tab, minus the accent bar).
  const syncBottomFocusMarker = (): void => {
    if (!bottomStripEl) return;
    const focused = !!openGroup
      && edgeOf(openGroup) === 'bottom'
      && openGroup.element.classList.contains('dv-active-group');
    bottomStripEl.classList.toggle('fx-bottom-edge-focused', focused);
  };

  const syncBottomOpenMarker = (): void => {
    if (!bottomStripEl) return;
    const isBottomOpen = !!openGroup && edgeOf(openGroup) === 'bottom';
    bottomStripEl.classList.toggle('fx-bottom-edge-open', isBottomOpen);
    syncBottomFocusMarker();
  };

  // Hard close — dispose / switching to another edge group.
  const forceClose = (): void => {
    if (!openGroup) return;
    openGroup.element.classList.remove(OPEN_CLASS, ANIM_CLASS);
    grip.remove();
    openGroup = null;
    syncBottomOpenMarker();
  };

  const open = (group: DockviewGroupPanel): void => {
    if (openGroup && openGroup !== group) {
      openGroup.element.classList.remove(OPEN_CLASS, ANIM_CLASS);
      grip.remove();
      openGroup = null;
    }
    openGroup = group;
    group.element.classList.add(OPEN_CLASS);
    group.element.appendChild(grip);
    position(group);
    kickAnim(group);
    syncBottomOpenMarker();
  };

  // Soft dismiss (outside-click / re-click active tab), UE rules:
  //   • active tab is pinned            → keep open (no-op)
  //   • active is non-pin, group has pin → snap back to the pinned tab
  //   • no pin in group                 → close the drawer
  const close = (): void => {
    if (!openGroup) return;
    const group = openGroup;
    if (activeIsPinned(group)) return;
    const pinnedId = pinnedPanelId(group);
    if (pinnedId) {
      const pinned = findPanel(group, pinnedId);
      if (pinned) {
        try { pinned.api.setActive(); } catch { /* noop */ }
        kickAnim(group);
        return;
      }
    }
    forceClose();
  };

  // Per-TAB pin toggle. Same-group pins are mutually exclusive: pinning B
  // clears A's pin. Pinning activates that tab; opens the drawer only if it
  // was closed — never kickAnim (pin is a state toggle, not an open).
  const togglePin = (group: DockviewGroupPanel, panel: IDockviewPanel): void => {
    const cur = pinnedPanelId(group);
    if (cur === panel.id) {
      setEdgePin(group.id, undefined);
    } else {
      setEdgePin(group.id, panel.id);
      try { panel.api.setActive(); } catch { /* noop */ }
      if (openGroup !== group) open(group);
    }
  };

  // Drag the grip → rewrite the size var (clamped). Pointer capture keeps the drag
  // alive even when the cursor leaves the 6px bar.
  const onGripPointerDown = (e: PointerEvent): void => {
    if (!openGroup) return;
    e.preventDefault();
    e.stopPropagation();
    const group = openGroup;
    const edge = edgeOf(group);
    const r = group.element.getBoundingClientRect();
    // Keep the lime bar lit for the whole drag: pointer capture can drop :hover /
    // :active, so we drive the highlight with an explicit class instead.
    grip.classList.add('fx-edge-drawer-grip--dragging');
    try { grip.setPointerCapture(e.pointerId); } catch { /* noop */ }
    const move = (ev: PointerEvent): void => {
      let size: number;
      if (edge === 'left') size = ev.clientX - r.right;
      else if (edge === 'right') size = r.left - ev.clientX;
      else if (edge === 'top') size = ev.clientY - r.bottom;
      else size = r.top - ev.clientY;
      size = Math.max(160, Math.min(size, 900));
      group.element.style.setProperty(sizeVar(edge), `${size}px`);
      positionGrip(group);
    };
    const up = (ev: PointerEvent): void => {
      grip.classList.remove('fx-edge-drawer-grip--dragging');
      try { grip.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  };
  grip.addEventListener('pointerdown', onGripPointerDown);

  // Resolve the edge group owning a strip element (tab / chrome). Handles both
  // the in-place left/right strips (under `root`) and the relocated bottom strip
  // (in the footer, outside `root`).
  const edgeGroupForStripEl = (el: Element): DockviewGroupPanel | undefined => {
    if (bottomStripEl && bottomStripEl.contains(el)) return edgeGroupAt('bottom');
    const groupEl = el.closest('.dv-groupview-edge');
    if (groupEl && root.contains(groupEl)) return edgeGroupFromElement(api, groupEl);
    return undefined;
  };

  // Void / strip chrome (not a tab) calls dockview doSetGroupActive on
  // pointerdown — that lights the last active tab via our UE accent without
  // opening the drawer. Swallow those activations; real tab clicks handle
  // setActive themselves below.
  const onStripChromePointerDown = (e: PointerEvent): void => {
    const target = e.target as Element | null;
    if (!target) return;
    const inBottom = !!bottomStripEl && bottomStripEl.contains(target);
    const groupEl = target.closest('.dv-groupview-edge');
    if (!inBottom && (!groupEl || !root.contains(groupEl))) return;
    if (target.closest('.dv-tab')) return;
    if (target.closest('.fx-edge-drawer-grip')) return;
    if (target.closest('.dv-content-container')) return;
    e.stopPropagation();
  };

  const onClickCapture = (e: MouseEvent): void => {
    const target = e.target as Element | null;
    const tabEl = target?.closest('.dv-tab');
    if (!tabEl) return;
    const group = edgeGroupForStripEl(tabEl);
    if (!group) return;
    // Edge-group tab: block dockview's native expand/resize entirely.
    e.preventDefault();
    e.stopPropagation();

    // Pin toggle (rendered by DockTab in place of close): flip THIS tab's pin.
    const pinBtn = target?.closest(`.${EDGE_PIN_CLASS}`) as HTMLElement | null;
    if (pinBtn) {
      const panelId = pinBtn.dataset.fxEdgePinPanel;
      const panel = panelId ? findPanel(group, panelId) : undefined;
      if (panel) togglePin(group, panel);
      return;
    }

    // Map the clicked tab → its panel by DOM order within the tabs container.
    const container = tabEl.closest('.dv-tabs-container');
    const tabs = container
      ? Array.from(container.querySelectorAll(':scope > .dv-tab'))
      : [];
    const index = tabs.indexOf(tabEl);
    const panel = index >= 0 ? group.panels[index] : undefined;
    // Always setActive — even when this panel is already the group's active
    // panel. Otherwise clicking a strip tab while focus is on another group
    // never promotes this edge group to `dv-active-group`, so the UE focus
    // tab accent never lights up.
    const wasActive = panel != null && group.activePanel === panel;
    if (panel) {
      try { panel.api.setActive(); } catch { /* noop */ }
    }
    // Re-click active tab → soft dismiss (pin rules inside close()).
    // Same-strip switch → re-kick wipe-in. Else open the drawer.
    if (openGroup === group && wasActive) close();
    else if (openGroup === group && !wasActive) kickAnim(group);
    else open(group);
  };

  // Outside click → soft dismiss (pin rules inside close()).
  const onPointerDownCapture = (e: PointerEvent): void => {
    if (!openGroup) return;
    // Active pinned tab: never auto-dismiss on outside click.
    if (activeIsPinned(openGroup)) return;
    const target = e.target as Element | null;
    if (target && openGroup.element.contains(target)) return;
    // The relocated bottom strip lives in the footer (outside openGroup.element)
    // yet re-clicking it must route through onClickCapture, not auto-dismiss.
    if (target && bottomStripEl && bottomStripEl.contains(target)) return;
    close();
  };

  const reposition = (): void => { if (openGroup) position(openGroup); };

  // Hide edge strips with zero tabs. Dropping back uses the root's narrow
  // edge overlay (kind:'edge') — see willDropSub — which routes into the
  // registered edge group and re-shows it. No need to flash empty strips
  // during drag.
  const syncEmptyEdges = (): void => {
    for (const pos of EDGE_POSITIONS) {
      if (!api.getEdgeGroup(pos)) continue;
      const group = edgeGroups(api).find((g) => {
        const loc = g.api.location;
        return loc.type === 'edge' && loc.position === pos;
      });
      const hasItems = (group?.panels.length ?? 0) > 0;
      try { api.setEdgeGroupVisible(pos, hasItems); } catch { /* noop */ }
      if (group) {
        group.element.classList.toggle('fx-edge-empty', !hasItems);
      }
      if (!hasItems && group) {
        setEdgePin(group.id, undefined);
        if (openGroup === group) forceClose();
      }
    }
    // Keep the footer strip parented + its host empty-state in sync.
    relocateBottomStrip();
  };

  const edgeGroupAt = (pos: EdgePosition): DockviewGroupPanel | undefined =>
    edgeGroups(api).find((g) => {
      const loc = g.api.location;
      return loc.type === 'edge' && loc.position === pos;
    });

  // Move dockview's bottom-edge `.dv-tabs-and-actions-container` out of the
  // (collapsed, hidden) splitview cell and into the StatusBar footer host, so
  // the dock tabs share the footer row with the status items. The relocated
  // element is the REAL dockview tab strip → native drag in/out, native drop
  // targets and our click interceptor all keep working. Idempotent; re-run on
  // every layout change (reset/fromJSON disposes the group → new container).
  const relocateBottomStrip = (): void => {
    const host = footerHost();
    if (!host) return;
    const group = edgeGroupAt('bottom');
    // Resolve THIS group's live strip. Order matters:
    //   1. If the strip is still under the group (not yet relocated) → use it.
    //   2. Else if it's the SAME group we already relocated → reuse bottomStripEl.
    //   3. Else it's a NEW group whose header isn't built yet → BAIL. Never fall
    //      back to a previous group's detached strip; that's exactly what made
    //      the footer flash correct then blank on the 2nd hydration pass.
    let container: HTMLElement | null = null;
    if (group) {
      container = group.element.querySelector<HTMLElement>(':scope > .dv-tabs-and-actions-container');
      if (!container && bottomGroupId === group.id) container = bottomStripEl;
      if (!container) { if (bailFrames++ < 180) scheduleRelocate(); return; }
    } else {
      container = bottomStripEl;
    }
    bailFrames = 0;
    // Drop any stale strip a disposed group left behind in the host.
    for (const child of Array.from(host.children)) {
      if (child !== container) child.remove();
    }
    if (container && container.parentElement !== host) {
      host.appendChild(container);
      container.classList.add('fx-bottom-edge-strip');
    }
    if (container) {
      // dockview lays the collapsed (height-0) bottom group out in the shell and
      // can stamp inline height/width/display on the tabs container + its tab
      // strip; carried into the footer those inline values win over our CSS and
      // render the relocated strip at 0 size (invisible until a later reflow —
      // the "refresh shows nothing until you click" bug). Strip them so our
      // footer CSS controls sizing, then force a reflow to paint immediately.
      for (const prop of ['height', 'width', 'display'] as const) {
        container.style.removeProperty(prop);
        (container.querySelector<HTMLElement>(':scope > .dv-tabs-container'))?.style.removeProperty(prop);
      }
      void container.offsetHeight;
    }
    bottomStripEl = container ?? null;
    if (group) bottomGroupId = group.id;
    syncBottomOpenMarker();
    // Redirect this group's drop overlays to the footer-anchored host so tab
    // reorder / receive highlights render over the footer, not the shell.
    if (group) attachBottomDropContainer(group);
    host.classList.toggle('is-empty', (group?.panels.length ?? 0) === 0);
  };

  // Default editor layout may put panels only in the grid. Still register the
  // left/right/bottom edge slots (hidden while empty) so outermost drop and
  // "Move to Side" have a destination without flashing empty strips.
  const ensureEdgeSlots = (): void => {
    for (const pos of ENSURED_EDGE_SLOTS) {
      if (api.getEdgeGroup(pos)) continue;
      try {
        api.addEdgeGroup(pos, {
          id: `edge-${pos}`,
          initialSize: pos === 'bottom' ? 280 : 260,
          // Bottom is footer-merged: its collapsed splitview cell must take ZERO
          // height (the strip is relocated into the StatusBar), otherwise a blank
          // 35px bar would sit above the footer. Left/right keep the strip in the
          // grid so use the theme default collapsed width.
          ...(pos === 'bottom' ? { collapsedSize: 0 } : {}),
          collapsed: true,
        });
        api.setEdgeGroupVisible(pos, false);
      } catch { /* noop */ }
    }
    forceBottomCollapsedZero();
  };

  // Force the bottom edge's collapsed cell to ZERO height. dockview's
  // `fromJSON` auto-creates edge groups from serialized `edgeGroups` using the
  // theme default collapsedSize (35) and ignores the collapsedSize we pass to
  // addEdgeGroup — so a persisted / default layout leaves a blank 35px band
  // above the footer (the strip itself is relocated into the StatusBar) and
  // parks the bottom drop overlay there. There is no public collapsedSize
  // setter, so reach the ShellManager's EdgeGroupView and shrink it in place.
  // Guarded: if dockview's internals move this becomes a no-op (empty band is
  // cosmetic, never functional). Left/right keep the theme default.
  const forceBottomCollapsedZero = (): void => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shell = (api as any).component?._shellManager;
      const view = shell?._bottomView;
      if (!view || view.collapsedSize === 0) return;
      // (collapsedSize, expandedMinimumSize) — keep expanded-min sane (>0).
      view.updateCollapsedSize(0, 50);
      if (view.isCollapsed) shell._middleColumn.resizeView('bottom', 0);
    } catch { /* dockview internals moved — empty band is cosmetic */ }
  };

  // ── Global footer-chrome owner ───────────────────────────────────────────
  // The footer panels (Info / Checkpoints / Events) are interface-level chrome
  // that must exist under EVERY layout — every workbench AND every Page — not be
  // re-seeded into each layout's JSON. This reconciler is that single owner:
  // installEdgeDrawer runs once per DockShell region and persists across every
  // workbench / Page switch, so after each layout change we ensure any missing
  // footer panel is (re)added into the bottom edge group. Panels are inserted
  // straight into the edge group (position.referenceGroup) so they never detour
  // through the grid.
  //
  // `ensuringFooter` does double duty: reentrancy guard AND a "batch in progress"
  // flag the layout/panel event handlers below check to STAY QUIET. Adding a panel
  // (and the moveTo fallback) each fire onDidAddPanel / onDidActivePanelChange /
  // onDidLayoutChange, so without suppression every insert would re-run relocate
  // and each new panel would momentarily steal the active tab — the "tabs randomly
  // focus" churn seen on page switch. Instead we do all inserts silently, restore
  // the pre-existing active panel so the footer never steals focus from the page
  // content, and let the SINGLE post-ensure reconcile relocate the strip once.
  let ensuringFooter = false;
  const ensureFooterPanels = (): void => {
    if (ensuringFooter) return;
    const bottom = edgeGroupAt('bottom');
    if (!bottom) return; // ensureEdgeSlots creates it; a later tick retries
    // Steady state (footer already complete): do nothing — onDidLayoutChange fires
    // on every resize/drag, so a no-op fast-path keeps those churn-free.
    if (FOOTER_PANEL_ID_LIST.every((id) => api.getPanel(id))) return;
    ensuringFooter = true;
    // Preserve whatever the page had focused so a freshly-added footer tab (an
    // empty group's first panel is force-active; moveTo also activates) can't grab
    // the active group.
    const prevActive = api.activePanel;
    try {
      FOOTER_PANEL_ID_LIST.forEach((id, index) => {
        // Only ADD a fully-absent footer panel — never relocate one the user has
        // dragged elsewhere (respecting a user who moved Info into the grid).
        if (api.getPanel(id)) return;
        try {
          api.addPanel({
            id,
            component: id,
            title: id,
            position: { referenceGroup: bottom, direction: 'within', index },
            inactive: true,
          });
          // Guarantee it landed in the bottom edge group: referenceGroup targeting
          // can fall back to a fresh grid group on some dockview builds. Moving it
          // in the SAME tick (before paint) keeps the add flash-free. moveTo-into-
          // edge is the proven path (see willDropSub).
          const panel = api.getPanel(id);
          if (panel && panel.group !== bottom) {
            try { panel.api.moveTo({ group: bottom, position: 'center' }); } catch { /* noop */ }
          }
        } catch { /* component not registered in this host — skip */ }
      });
      try { prevActive?.api.setActive(); } catch { /* prevActive was closed — noop */ }
    } finally {
      ensuringFooter = false;
    }
  };

  // Normalize to collapsed on install. In our model an edge group is ALWAYS
  // collapsed (a narrow strip); "expansion" is the fixed drawer overlay, never a
  // splitview resize. A previously-persisted expanded state (collapsed:false)
  // would otherwise restore as a full-width column that can't be closed — the
  // native tab-click collapse is intercepted below. collapse() is a no-op when
  // already collapsed.
  const normalize = (): void => {
    for (const group of edgeGroups(api)) {
      try { group.api.collapse(); } catch { /* noop */ }
    }
  };

  // Safety net: the drawer is a pure overlay and must never become a splitview
  // resize. If anything (a missed click, a future dockview code path) expands an
  // edge group, snap it straight back to collapsed so the grid never shifts.
  const collapseGuards: Array<{ dispose: () => void }> = [];
  const rebindCollapseGuards = (): void => {
    for (const d of collapseGuards) { try { d.dispose(); } catch { /* noop */ } }
    collapseGuards.length = 0;
    for (const group of edgeGroups(api)) {
      collapseGuards.push(group.api.onDidCollapsedChange((ev) => {
        if (!ev.isCollapsed) { try { group.api.collapse(); } catch { /* noop */ } }
      }));
    }
  };

  ensureEdgeSlots();
  ensureFooterPanels();
  normalize();
  rebindCollapseGuards();
  relocateBottomStrip();
  syncEmptyEdges();

  // The StatusBar footer host may mount well after the dock, and the layout is
  // hydrated by SEVERAL async paths (onReady restore, applyPageScope, and the
  // project-id resolve round-trip to /api/workbench/games). Any of these can
  // create the real bottom group AFTER our first relocate. Keep re-running the
  // (idempotent) relocate until the strip is actually parented into the footer
  // host, with a generous frame cap so a late-mounting footer or late hydration
  // still lands without waiting for a user click. syncEmptyEdges is re-run too
  // so the just-parented strip's empty-state / visibility is correct.
  let relocateTries = 0;
  const relocateRetry = (): void => {
    relocateBottomStrip();
    const host = footerHost();
    const landed = !!host && !!bottomStripEl && bottomStripEl.parentElement === host;
    if (landed) { syncEmptyEdges(); return; }
    if (relocateTries++ > 240) return; // ~4s backstop
    requestAnimationFrame(relocateRetry);
  };
  requestAnimationFrame(relocateRetry);

  // Listeners live on `document` (capture): the bottom strip is relocated into
  // the footer, OUTSIDE `root`, so a root-scoped listener would miss its tabs.
  // edgeGroupForStripEl / the bottom-strip containment checks re-gate to our
  // edge groups only.
  document.addEventListener('pointerdown', onStripChromePointerDown, true);
  document.addEventListener('click', onClickCapture, true);
  document.addEventListener('pointerdown', onPointerDownCapture, true);
  window.addEventListener('resize', reposition);

  // Reveal the footer drop zone ONLY during a real HTML5 tab drag. We can't
  // reuse DockRegion's `fx-dock-dragging` flag: that also flips on a plain
  // pointerdown on a tab strip (to catch floating-group pointer drags), so a
  // mere CLICK on a footer tab would flash the drop affordance. `dragstart` /
  // `dragend` only fire for an actual drag, so gate the footer zone on our own
  // `fx-edge-drag` class instead.
  const DRAG_CLASS = 'fx-edge-drag';
  const onAnyDragStart = (e: DragEvent): void => {
    const t = e.target as Element | null;
    if (t?.closest?.('.dv-tab') || t?.closest?.('.dv-tabs-and-actions-container')) {
      document.documentElement.classList.add(DRAG_CLASS);
    }
  };
  const clearDragClass = (): void => {
    document.documentElement.classList.remove(DRAG_CLASS);
    // Backstop: wipe any footer drop overlay dockview left behind when the drag
    // ended on a group other than the bottom edge.
    clearDropAnchor();
  };
  // Keep the "exactly one live drop overlay" invariant. dockview can rely on
  // `onDragLeave` doing NOTHING for an override target because its own anchor
  // container is SHARED by every droptarget in the instance: whoever becomes the
  // target next repositions that single overlay. Our footer shim is a SECOND,
  // group-exclusive container, so nothing ever took the footer's overlay down —
  // dragging a footer tab up into the grid painted the grid's zone while the
  // footer's lime rectangle stayed, two live drop zones at once. Wipe ours as
  // soon as the drag is over anything outside the strip; coming back fires a
  // real `dragenter`, which rebuilds it through `getElements()`.
  const overBottomStrip = (node: Node | null): boolean => {
    if (!node) return false;
    if (bottomStripEl?.contains(node)) return true;
    // Before the footer relocation lands, the strip is still inside its group.
    const bottom = edgeGroupAt('bottom');
    return !!bottom && bottom.element.contains(node);
  };
  const onAnyDragOver = (e: DragEvent): void => {
    if (!dropAnchorModel) return;
    if (overBottomStrip(e.target as Node | null)) return;
    clearDropAnchor();
  };
  window.addEventListener('dragstart', onAnyDragStart, true);
  window.addEventListener('dragover', onAnyDragOver, true);
  window.addEventListener('dragend', clearDragClass, true);
  window.addEventListener('drop', clearDragClass, true);

  // Programmatic drawer control (chrome-drawer's `app.drawer.*` commands — e.g.
  // the HealthIndicator chip toggling "Info"). Event name kept as a bare literal
  // to avoid an interface→extensions import; chrome-drawer emits the same string.
  const onEdgeDrawerCmd = (e: Event): void => {
    const detail = (e as CustomEvent).detail as { action?: string; id?: string } | undefined;
    if (!detail) return;
    if (detail.action === 'close') { close(); return; }
    const id = detail.id;
    if (!id) return;
    const panel = api.getPanel(id);
    if (!panel) return;
    const group = edgeGroups(api).find((g) => g.panels.some((p) => p.id === id));
    if (!group) return;
    // toggle: re-hitting the already-open active panel closes it.
    if (detail.action === 'toggle' && openGroup === group && group.activePanel?.id === id) {
      close();
      return;
    }
    try { panel.api.setActive(); } catch { /* noop */ }
    open(group);
  };
  window.addEventListener('forgeax:edge-drawer', onEdgeDrawerCmd);
  const layoutSub = api.onDidLayoutChange(() => {
    // Silent while ensureFooterPanels is batching — its addPanel/moveTo calls fire
    // this; the caller does the single reconcile once the batch completes.
    if (ensuringFooter) return;
    reposition();
    // fromJSON / reset may drop edge slots — re-create empty ones for drop.
    ensureEdgeSlots();
    // …then re-assert the global footer chrome for the new layout.
    ensureFooterPanels();
    normalize();
    rebindCollapseGuards();
    // Reset/fromJSON disposes+recreates the bottom group → re-relocate its strip.
    relocateBottomStrip();
    syncEmptyEdges();
  });
  // Panel add/remove is the precise moment an edge can become empty / non-empty;
  // layout-change alone can miss it depending on dockview's event ordering.
  const addPanelSub = api.onDidAddPanel(() => { if (ensuringFooter) return; relocateBottomStrip(); syncEmptyEdges(); });
  const remPanelSub = api.onDidRemovePanel(() => { syncEmptyEdges(); });
  // fromJSON hydration fires ONLY `onDidLayoutFromJSON` — NOT `onDidLayoutChange`
  // (a gridview AsapEvent that ignores edge groups, which live in the shell
  // splitview) and NOT per-panel `onDidAddPanel` for edge groups (addEdgeGroup
  // never forwards it). So a refresh that restores a bottom panel left the strip
  // un-relocated until an unrelated grid click finally fired onDidLayoutChange —
  // the "shows only after clicking dockview" bug. Reconcile here explicitly.
  const fromJsonSub = api.onDidLayoutFromJSON(() => {
    ensureEdgeSlots();
    ensureFooterPanels();
    normalize();
    rebindCollapseGuards();
    relocateBottomStrip();
    syncEmptyEdges();
  });
  // Active-panel changes fire during hydration once a restored bottom panel is
  // made active — a cheap extra beat to catch strips the layout-change path may
  // have relocated before their tabs were fully populated.
  const activeSub = api.onDidActivePanelChange(() => { if (ensuringFooter) return; relocateBottomStrip(); syncBottomFocusMarker(); });

  // Root edge drop (the thin outermost overlay) normally orthogonalizes into a
  // NEW grid group. When we already own an edge-group slot at that position,
  // steal the drop: preventDefault → show the slot → move the panel into it.
  // Empty sidebars stay hidden until this lands — no drag-time flash.
  const willDropSub = api.onWillDrop((e) => {
    if (e.kind !== 'edge') return;
    const pos = e.position as EdgePosition;
    if (!(EDGE_POSITIONS as readonly string[]).includes(pos)) return;
    if (!api.getEdgeGroup(pos)) return;
    const edgeGroup = edgeGroupAt(pos);
    if (!edgeGroup) return;
    const data = e.getData?.();
    const panelId = data?.panelId;
    if (!panelId) return;
    const panel = api.getPanel(panelId);
    if (!panel) return;

    e.preventDefault();
    try { api.setEdgeGroupVisible(pos, true); } catch { /* noop */ }
    edgeGroup.element.classList.remove('fx-edge-empty');
    try {
      panel.api.moveTo({ group: edgeGroup, position: 'center' });
    } catch { /* noop */ }
    try { edgeGroup.api.collapse(); } catch { /* noop */ }
    open(edgeGroup);
    syncEmptyEdges();
  });

  return () => {
    forceClose();
    clearEdgePins();
    // Return the relocated strip to nowhere-in-particular; dockview disposes it
    // with the group. Just drop our footer marker so a stale strip can't linger.
    try { bottomStripEl?.remove(); } catch { /* noop */ }
    bottomStripEl = null;
    bottomGroupId = null;
    if (relocateRaf) { cancelAnimationFrame(relocateRaf); relocateRaf = 0; }
    try { bottomDropContainer.dispose(); } catch { /* noop */ }
    document.removeEventListener('pointerdown', onStripChromePointerDown, true);
    document.removeEventListener('click', onClickCapture, true);
    document.removeEventListener('pointerdown', onPointerDownCapture, true);
    window.removeEventListener('resize', reposition);
    window.removeEventListener('dragstart', onAnyDragStart, true);
    window.removeEventListener('dragover', onAnyDragOver, true);
    window.removeEventListener('dragend', clearDragClass, true);
    window.removeEventListener('drop', clearDragClass, true);
    window.removeEventListener('forgeax:edge-drawer', onEdgeDrawerCmd);
    document.documentElement.classList.remove(DRAG_CLASS);
    try { layoutSub.dispose(); } catch { /* noop */ }
    try { addPanelSub.dispose(); } catch { /* noop */ }
    try { remPanelSub.dispose(); } catch { /* noop */ }
    try { activeSub.dispose(); } catch { /* noop */ }
    try { fromJsonSub.dispose(); } catch { /* noop */ }
    try { willDropSub.dispose(); } catch { /* noop */ }
    for (const g of collapseGuards) { try { g.dispose(); } catch { /* noop */ } }
  };
}
