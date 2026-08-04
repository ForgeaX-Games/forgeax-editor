import { useMemo, useState, useSyncExternalStore } from 'react';
import { Box, MoreHorizontal, Pin } from 'lucide-react';
import type { QualifiedActivityId } from '@forgeax/types';
import { useHost } from '../../core/app-shell';
import { STORAGE_KEYS } from '../../lib/storageKeys';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import './ActivityRail.css';

function readPinned(): string[] | null {
  try {
    const value = localStorage.getItem(STORAGE_KEYS.activityRailPinned);
    if (value === null) return null;
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : null;
  } catch { return null; }
}

function writePinned(ids: readonly string[]): void {
  try { localStorage.setItem(STORAGE_KEYS.activityRailPinned, JSON.stringify(ids)); } catch { /* quota */ }
}

export function ActivityRail() {
  const host = useHost();
  const catalog = useSyncExternalStore(
    host.activities.subscribe,
    host.activities.getSnapshot,
    host.activities.getSnapshot,
  );
  const pages = useSyncExternalStore(host.pages.subscribe, host.pages.getSnapshot, host.pages.getSnapshot);
  const [savedPinned, setSavedPinned] = useState<string[] | null>(() => readPinned());
  const [moreOpen, setMoreOpen] = useState(false);
  const allIds = useMemo(() => catalog.activities.map((activity) => activity.id), [catalog]);
  const pinnedIds = savedPinned ?? allIds;
  const pinned = catalog.activities.filter((activity) => pinnedIds.includes(activity.id));
  const unpinned = catalog.activities.filter((activity) => !pinnedIds.includes(activity.id));
  const activeTypeId = pages.instances.find((page) => page.encodedKey === pages.activeKey)?.typeId;

  const togglePin = (id: string): void => {
    const next = pinnedIds.includes(id) ? pinnedIds.filter((candidate) => candidate !== id) : [...pinnedIds, id];
    setSavedPinned(next);
    writePinned(next);
  };

  const button = (activity: (typeof catalog.activities)[number], pinnedItem: boolean) => {
    const active = activity.pageTypeId === activeTypeId;
    return (
      <Tooltip key={activity.id}>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={`activity-rail-item${active ? ' active' : ''}`}
            aria-label={activity.title}
            aria-current={active ? 'page' : undefined}
            data-activity-id={activity.id}
            onClick={() => void host.activities.launch(activity.id as QualifiedActivityId)}
          >
            <span className="activity-rail-item-ic" aria-hidden><Box size={22} strokeWidth={1.7} /></span>
            <span className="activity-rail-item-lb">{activity.title}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={10} className="activity-rail-plugin-tip">
          <div className="activity-rail-plugin-tip-title">{activity.title}</div>
          <div className="activity-rail-plugin-tip-category">{activity.category ?? 'general'}</div>
          {!pinnedItem && (
            <button type="button" onClick={() => togglePin(activity.id)}>
              <Pin size={12} /> Pin
            </button>
          )}
        </TooltipContent>
      </Tooltip>
    );
  };

  return (
    <TooltipProvider delayDuration={260} skipDelayDuration={80}>
      <nav className="activity-rail thin-scrollbar" aria-label="Page activities" data-fx-slot="ActivityRail">
        <div className="activity-rail-group" data-category="pinned">
          {pinned.map((activity) => button(activity, true))}
        </div>
        {unpinned.length > 0 && (
          <div className="activity-rail-group activity-rail-group--more">
            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger asChild>
                <button type="button" className="activity-rail-item" aria-label="More pages">
                  <span className="activity-rail-item-ic"><MoreHorizontal size={22} /></span>
                  <span className="activity-rail-item-lb">More</span>
                </button>
              </PopoverTrigger>
              <PopoverContent side="right" align="end" sideOffset={10} className="activity-rail-more">
                <div className="activity-rail-more-hd">More pages</div>
                <div className="activity-rail-more-body">{unpinned.map((activity) => button(activity, false))}</div>
              </PopoverContent>
            </Popover>
          </div>
        )}
      </nav>
    </TooltipProvider>
  );
}
