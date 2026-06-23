import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore, seedUninstalledIfFirstRun } from '../../store';

type WorkbenchAgent = {
  id: string;
  name: string;
  role: string;
  status?: string;
  isMain?: boolean;
};

const MAX_PAGE_SIZE = 5;
const MIN_PAGE_SIZE = 2;
const HOVER_AGENT_SLOT_PX = 70;
const HOVER_CAPSULE_CHROME_PX = 56;
const WHEEL_DELTA_MIN = 15;
const DRAG_PAGE_THRESHOLD_PX = 36;
const DRAG_CAPTURE_THRESHOLD_PX = 6;
const WHEEL_COOLDOWN_MS = 280;
const EDGE_HOVER_ZONE_PX = 38;
const EDGE_AUTO_PAGE_DELAY_MS = 880;
const EDGE_AUTO_PAGE_INTERVAL_MS = 1500;
const PAGE_ANIMATION_MS = 320;

function pageSizeForWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return MAX_PAGE_SIZE;
  const availableSlots = Math.floor((width - HOVER_CAPSULE_CHROME_PX) / HOVER_AGENT_SLOT_PX);
  return Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, availableSlots));
}

function handleFor(id: string): string {
  if (id.includes('cc-coder')) return 'cc-coder';
  return id.split('-')[0] ?? id;
}

// Stable fallback so Zustand's strict-equality check doesn't see a new {}
// object on every render when the active tab isn't found yet.
const EMPTY_STREAMING: Record<string, boolean> = {};

function initialFor(id: string): string {
  const handle = handleFor(id);
  const parts = handle.split(/[-_.]/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  return handle.slice(0, 2).toUpperCase();
}

/**
 * Horizontal facepile strip — shows up to PAGE_SIZE agents at a time.
 * When there are more agents, hover reveals left/right pagination arrows,
 * a page-dot indicator, and wheel / horizontal-drag paging on the strip.
 *
 * States:
 *   • hover    → avatar scales up, name slides in below (CSS only, zero JS)
 *   • loading  → spinning ring overlaid on the avatar while that agent streams
 *   • unread   → red dot in corner when a non-active agent receives new output
 *   • selected → 2px brand-color border on the avatar circle
 */
export function ChatAgentCapsule() {
  const activeSid = useAppStore((s) => s.activeSid);
  const tabs = useAppStore((s) => s.tabs);
  const setTabAgent = useAppStore((s) => s.setTabAgent);
  const uninstalledIds = useAppStore((s) => s.uninstalledAgentIds);
  const defaultBootstrap = useAppStore((s) => s.defaultBootstrapAgent);
  const activeAgentId = tabs.find((t) => t.sid === activeSid)?.agentId ?? null;

  const streamingByAgent = useAppStore(
    (s) => s.tabs.find((t) => t.sid === s.activeSid)?.streamingByAgent ?? EMPTY_STREAMING,
  );

  const [agents, setAgents] = useState<WorkbenchAgent[]>([]);
  const [unreadAgents, setUnreadAgents] = useState<Set<string>>(new Set());
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(MAX_PAGE_SIZE);
  const [wrapHovered, setWrapHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hoverEdge, setHoverEdge] = useState<'prev' | 'next' | null>(null);
  const [pageMotion, setPageMotion] = useState<'prev' | 'next' | null>(null);
  const prevStreamingRef = useRef<Record<string, boolean>>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  const wheelCooldownRef = useRef(false);
  const edgeAutoDelayRef = useRef<number | null>(null);
  const edgeAutoIntervalRef = useRef<number | null>(null);
  const pageMotionTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{
    active: boolean;
    startX: number;
    pointerId: number;
    captured: boolean;
  } | null>(null);

  const manifestMainId = agents.find((a) => a.isMain)?.id ?? null;
  const effectiveMainId = defaultBootstrap ?? manifestMainId;
  const activePriorityKey = useMemo(() => {
    const working = Object.entries(streamingByAgent)
      .filter(([, running]) => running)
      .map(([agentId]) => agentId)
      .sort()
      .join('|');
    const unread = [...unreadAgents].sort().join('|');
    return `${activeAgentId ?? ''}::${working}::${unread}`;
  }, [activeAgentId, streamingByAgent, unreadAgents]);
  const visibleAgents = useMemo(() => {
    const priorityScore = (agent: WorkbenchAgent): number => {
      if (agent.id === activeAgentId && streamingByAgent[agent.id]) return 0;
      if (streamingByAgent[agent.id]) return 1;
      if (agent.id === activeAgentId) return 2;
      if (unreadAgents.has(agent.id)) return 3;
      if (agent.id === effectiveMainId) return 4;
      return 5;
    };
    return agents
      .filter((a) => !uninstalledIds.includes(a.id) || a.id === activeAgentId)
      .map((agent, index) => ({ agent, index }))
      .sort((a, b) => {
        const score = priorityScore(a.agent) - priorityScore(b.agent);
        if (score !== 0) return score;
        return a.index - b.index;
      })
      .map(({ agent }) => agent);
  }, [agents, activeAgentId, effectiveMainId, streamingByAgent, uninstalledIds, unreadAgents]);

  const totalPages = Math.ceil(visibleAgents.length / pageSize) || 1;
  const needsPaging = visibleAgents.length > pageSize;
  const clampedPage = Math.min(pageIndex, totalPages - 1);
  const pagedAgents = visibleAgents.slice(clampedPage * pageSize, (clampedPage + 1) * pageSize);
  const hasPrev = clampedPage > 0;
  const hasNext = clampedPage < totalPages - 1;

  const updateHoverEdgeFromPoint = (clientX: number) => {
    if (!needsPaging || dragging) {
      setHoverEdge(null);
      return;
    }
    const capsule = wrapRef.current?.querySelector<HTMLElement>('.chat-agent-capsule');
    if (!capsule) return;
    const rect = capsule.getBoundingClientRect();
    const edgeWidth = Math.min(EDGE_HOVER_ZONE_PX, rect.width * 0.28);
    if (clientX - rect.left <= edgeWidth) {
      setHoverEdge(hasPrev ? 'prev' : null);
      return;
    }
    if (rect.right - clientX <= edgeWidth) {
      setHoverEdge(hasNext ? 'next' : null);
      return;
    }
    setHoverEdge(null);
  };

  const changePage = (dir: 1 | -1) => {
    setPageMotion(dir > 0 ? 'next' : 'prev');
    if (pageMotionTimerRef.current !== null) window.clearTimeout(pageMotionTimerRef.current);
    pageMotionTimerRef.current = window.setTimeout(() => {
      setPageMotion(null);
      pageMotionTimerRef.current = null;
    }, PAGE_ANIMATION_MS);
    setPageIndex((p) => Math.min(totalPages - 1, Math.max(0, p + dir)));
  };

  const resetPageToActiveAgent = () => {
    if (!activeAgentId) {
      setPageIndex(0);
      return;
    }
    const idx = visibleAgents.findIndex((a) => a.id === activeAgentId);
    setPageIndex(idx === -1 ? 0 : Math.floor(idx / pageSize));
  };

  useEffect(() => () => {
    if (pageMotionTimerRef.current !== null) window.clearTimeout(pageMotionTimerRef.current);
    if (edgeAutoDelayRef.current !== null) window.clearTimeout(edgeAutoDelayRef.current);
    if (edgeAutoIntervalRef.current !== null) window.clearInterval(edgeAutoIntervalRef.current);
  }, []);

  useEffect(() => {
    const host = wrapRef.current?.parentElement;
    if (!host) return;
    const update = (width: number) => {
      setPageSize((current) => {
        const next = pageSizeForWidth(width);
        return next === current ? current : next;
      });
    };
    update(host.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/workbench/agents?lang=zh')
      .then((r) => r.json())
      .then((j: { agents?: WorkbenchAgent[] }) => {
        if (cancelled) return;
        const list = j.agents ?? [];
        const main = list.find((a) => a.isMain)?.id;
        seedUninstalledIfFirstRun(list.map((a) => a.id), main);
        setAgents(list);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // When the active agent changes, jump to the page that contains it.
  useEffect(() => {
    if (!activeAgentId) return;
    const idx = visibleAgents.findIndex((a) => a.id === activeAgentId);
    if (idx === -1) return;
    setPageIndex(Math.floor(idx / pageSize));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentId, pageSize]);

  // Active / working / unread agents are promoted to the front; keep that new
  // priority visible instead of leaving the strip on a stale later page.
  useEffect(() => {
    if (visibleAgents.length === 0) return;
    setPageIndex(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePriorityKey, pageSize]);

  // When a non-active agent transitions from idle → streaming, mark it unread.
  useEffect(() => {
    const prev = prevStreamingRef.current;
    for (const [agentId, isStreaming] of Object.entries(streamingByAgent)) {
      if (isStreaming && !prev[agentId] && agentId !== activeAgentId) {
        setUnreadAgents((s) => new Set([...s, agentId]));
      }
    }
    prevStreamingRef.current = { ...streamingByAgent };
  }, [streamingByAgent, activeAgentId]);

  // Clear unread badge the moment the user switches to that agent.
  useEffect(() => {
    if (!activeAgentId) return;
    setUnreadAgents((prev) => {
      if (!prev.has(activeAgentId)) return prev;
      const next = new Set(prev);
      next.delete(activeAgentId);
      return next;
    });
  }, [activeAgentId]);

  // Wheel + horizontal drag to paginate while the strip is hovered.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !needsPaging || !wrapHovered) return;

    const maxPage = Math.max(0, Math.ceil(visibleAgents.length / pageSize) - 1);

    const step = (dir: 1 | -1) => {
      setPageMotion(dir > 0 ? 'next' : 'prev');
      if (pageMotionTimerRef.current !== null) window.clearTimeout(pageMotionTimerRef.current);
      pageMotionTimerRef.current = window.setTimeout(() => {
        setPageMotion(null);
        pageMotionTimerRef.current = null;
      }, PAGE_ANIMATION_MS);
      setPageIndex((p) => Math.min(maxPage, Math.max(0, p + dir)));
    };

    const onWheel = (e: WheelEvent) => {
      const delta =
        Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(delta) < WHEEL_DELTA_MIN) return;
      e.preventDefault();
      if (wheelCooldownRef.current) return;
      wheelCooldownRef.current = true;
      window.setTimeout(() => {
        wheelCooldownRef.current = false;
      }, WHEEL_COOLDOWN_MS);
      step(delta > 0 ? 1 : -1);
    };

    const clearDrag = (pointerId: number) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== pointerId) return;
      if (drag.captured && el.hasPointerCapture(pointerId)) {
        el.releasePointerCapture(pointerId);
      }
      dragRef.current = null;
      setDragging(false);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // Never steal clicks from chevrons or agent tabs.
      const target = e.target as HTMLElement;
      if (target.closest('.cas-nav-btn, .cas-btn')) return;
      dragRef.current = {
        active: true,
        startX: e.clientX,
        pointerId: e.pointerId,
        captured: false,
      };
    };

    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag?.active || drag.pointerId !== e.pointerId || drag.captured) return;
      if (Math.abs(e.clientX - drag.startX) < DRAG_CAPTURE_THRESHOLD_PX) return;
      drag.captured = true;
      setDragging(true);
      el.setPointerCapture(e.pointerId);
    };

    const onPointerUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag?.active || drag.pointerId !== e.pointerId) return;
      const dx = e.clientX - drag.startX;
      clearDrag(e.pointerId);
      if (!drag.captured) return;
      if (dx <= -DRAG_PAGE_THRESHOLD_PX) step(1);
      else if (dx >= DRAG_PAGE_THRESHOLD_PX) step(-1);
    };

    const onPointerCancel = (e: PointerEvent) => {
      clearDrag(e.pointerId);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerCancel);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerCancel);
    };
  }, [needsPaging, wrapHovered, visibleAgents.length, pageSize]);

  useEffect(() => {
    if (!needsPaging || !hoverEdge || dragging) return;
    if (hoverEdge === 'prev' && !hasPrev) return;
    if (hoverEdge === 'next' && !hasNext) return;
    const dir = hoverEdge === 'next' ? 1 : -1;
    const step = () => {
      changePage(dir);
    };
    edgeAutoDelayRef.current = window.setTimeout(() => {
      step();
      edgeAutoIntervalRef.current = window.setInterval(step, EDGE_AUTO_PAGE_INTERVAL_MS);
    }, EDGE_AUTO_PAGE_DELAY_MS);
    return () => {
      if (edgeAutoDelayRef.current !== null) window.clearTimeout(edgeAutoDelayRef.current);
      if (edgeAutoIntervalRef.current !== null) window.clearInterval(edgeAutoIntervalRef.current);
      edgeAutoDelayRef.current = null;
      edgeAutoIntervalRef.current = null;
    };
  }, [needsPaging, hoverEdge, dragging, hasPrev, hasNext, totalPages]);

  return (
    <div
      ref={wrapRef}
      className={[
        'chat-agent-capsule-wrap',
        needsPaging && 'has-paging',
        dragging && 'is-paging-drag',
        hoverEdge === 'prev' && 'is-edge-hover-prev',
        hoverEdge === 'next' && 'is-edge-hover-next',
        pageMotion === 'prev' && 'is-page-motion-prev',
        pageMotion === 'next' && 'is-page-motion-next',
      ]
        .filter(Boolean)
        .join(' ')}
      onMouseEnter={(event) => {
        setWrapHovered(true);
        updateHoverEdgeFromPoint(event.clientX);
      }}
      onMouseMove={(event) => updateHoverEdgeFromPoint(event.clientX)}
      onMouseLeave={() => {
        setWrapHovered(false);
        setHoverEdge(null);
        if (edgeAutoDelayRef.current !== null) window.clearTimeout(edgeAutoDelayRef.current);
        if (edgeAutoIntervalRef.current !== null) window.clearInterval(edgeAutoIntervalRef.current);
        edgeAutoDelayRef.current = null;
        edgeAutoIntervalRef.current = null;
        dragRef.current = null;
        setDragging(false);
        resetPageToActiveAgent();
      }}
    >
      <div className="cas-hover-moat" aria-hidden="true" />
      <div className="chat-agent-capsule" role="tablist" aria-label="Agents">
        {needsPaging && (
          <button
            type="button"
            className={['cas-nav-btn cas-nav-prev', !hasPrev && 'is-disabled'].filter(Boolean).join(' ')}
            aria-label="上一页"
            disabled={!hasPrev}
            onClick={() => changePage(-1)}
          >
            ‹
          </button>
        )}
        {pagedAgents.map((a) => {
          const selected = a.id === activeAgentId;
          const isLoading = !!streamingByAgent[a.id];
          const isUnread = !selected && unreadAgents.has(a.id);
          return (
            <button
              key={a.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={[
                'cas-btn',
                selected && 'is-selected',
                isLoading && 'is-loading',
                isUnread && 'is-unread',
              ]
                .filter(Boolean)
                .join(' ')}
              title={a.name}
              onClick={() => {
                if (activeSid) setTabAgent(activeSid, a.id);
              }}
            >
              <span className="cas-avatar-wrap">
                <span className="cas-avatar" aria-hidden>
                  {initialFor(a.id)}
                </span>
                {isLoading && <span className="cas-spinner" aria-hidden />}
                {isUnread && <span className="cas-unread-dot" aria-label="未读消息" />}
              </span>
              <span className="cas-name" aria-hidden="true">
                {a.name}
              </span>
            </button>
          );
        })}
        {needsPaging && (
          <button
            type="button"
            className={['cas-nav-btn cas-nav-next', !hasNext && 'is-disabled'].filter(Boolean).join(' ')}
            aria-label="下一页"
            disabled={!hasNext}
            onClick={() => changePage(1)}
          >
            ›
          </button>
        )}
      </div>
      {needsPaging && (
        <div className="cas-page-dots" aria-hidden="true">
          {Array.from({ length: totalPages }, (_, i) => (
            <span
              key={i}
              className={['cas-page-dot', i === clampedPage && 'is-active'].filter(Boolean).join(' ')}
            />
          ))}
        </div>
      )}
    </div>
  );
}
