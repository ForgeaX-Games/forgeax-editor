import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Box, Bot, MoreHorizontal, Pin, Search } from 'lucide-react';
import { useShellStore } from '../../store';
import { listExtensions, pickLang, type ExtensionInfo } from '../../lib/extension-api';
import { useSurface, type UISurfaceActionDef } from '../../lib/surface';
import { extensionRendersInMainArea } from '../MainArea/WorkbenchExtensionHost';
import { iconForWorkbenchModule } from '../../lib/workbench-module-icons';
import { setActiveWorkbench } from '../../lib/workbenches';
import { useActiveWorkbench } from '../../lib/useWorkbench';
import { STORAGE_KEYS } from '../../lib/storageKeys';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n';
import './ActivityRail.css';

// Shell-level persistent left activity bar. Lives in `.studio-body` as fixed
// chrome OUTSIDE dockview:
//   顶部固定 · 编辑器 / Agents
//   中间 · 用户置顶的插件（三点菜单里 pin）
//   底部 · 更多（⋯）
//
// Catalog is still product-spec curated (3D / 2D / General). Only spec'd
// plugins appear in the More menu; un-spec'd workbench plugins stay omitted.

interface RailItem {
  id: string; // wb:<workbench.id> — the tab id openWorkbench expects
  slug: string;
  category: '3D' | '2D' | 'general';
  label: string;
  description: string;
  manifest: ExtensionInfo;
}

// Product spec: category → ordered plugin slugs.
// 暂时隐藏(功能未就绪):方块人编辑(wb-lowpoly-obj)、Diffusion Renderer
// (wb-diffusion-renderer)。就绪后把 slug 加回对应分组即可恢复。
const RAIL_CATEGORIES: ReadonlyArray<{ category: '3D' | '2D' | 'general'; slugs: readonly string[] }> = [
  { category: '3D', slugs: ['wb-skill', 'wb-gen3d', 'wb-3d-lowpoly'] },
  { category: '2D', slugs: ['wb-character', 'wb-items', 'wb-anim', 'wb-2d-scene-asset-generator'] },
  { category: 'general', slugs: ['wb-ui', 'wb-narrative', 'wb-reel', 'wb-game-video', 'wb-bgm', 'wb-scene-generator'] },
];

/** First-run seed so upgrading users keep today's rail contents until they unpin. */
const DEFAULT_PINNED_SLUGS: readonly string[] = RAIL_CATEGORIES.flatMap((g) => g.slugs);

function slugOf(manifestId: string): string {
  return manifestId.replace(/^@forgeax-extension\//, '').replace(/^@forgeax-plugin\//, '');
}

function readPinnedSlugs(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.activityRailPinned);
    if (raw == null) return [...DEFAULT_PINNED_SLUGS];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_PINNED_SLUGS];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [...DEFAULT_PINNED_SLUGS];
  }
}

function writePinnedSlugs(slugs: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS.activityRailPinned, JSON.stringify(slugs));
  } catch {
    /* ignore quota / private mode */
  }
}

// P9 dual-modality — schema the AI reads to learn selectTab / setMode value ranges.
const HOST_SIDEBAR_SCHEMA = {
  type: 'object',
  properties: {
    workbenchTab: { type: 'string', description: 'Currently active workbench tab id (e.g. agents, wb:character)' },
    mode: { type: 'string', enum: ['scene', 'ai'] },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          kind: { type: 'string', enum: ['builtin', 'bus'] },
        },
      },
    },
  },
} as const;

interface HostSidebarSnapshot {
  workbenchTab: string;
  mode: 'scene' | 'ai';
  entries: Array<{ id: string; label: string; kind: 'builtin' | 'bus' }>;
}

export function ActivityRail() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language.startsWith('zh') ? 'zh' : 'en';
  const workbenchTab = useShellStore((s) => s.workbenchTab);
  // "mode" is derived from the active workspace (SSOT lives in workbenches.ts).
  const mode: 'scene' | 'ai' = useActiveWorkbench()?.id === 'scene' ? 'scene' : 'ai';

  const [busExtensions, setBusExtensions] = useState<ExtensionInfo[] | null>(null);
  const [pinnedSlugs, setPinnedSlugs] = useState<string[]>(() => readPinnedSlugs());
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreQuery, setMoreQuery] = useState('');
  const moreSearchRef = useRef<HTMLInputElement | null>(null);

  // Persistent component: retry the fetch a few times so a slow boot doesn't
  // pin the rail to an empty plugin list for the whole session.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const MAX_ATTEMPTS = 10;
    const RETRY_MS = 1500;
    const load = () => {
      attempts += 1;
      listExtensions('workbench')
        .then((res) => { if (!cancelled) setBusExtensions(res.items); })
        .catch(() => {
          if (cancelled) return;
          if (attempts >= MAX_ATTEMPTS) { setBusExtensions([]); return; }
          timer = setTimeout(load, RETRY_MS);
        });
    };
    load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  // Full catalog groups (installed ∩ spec). Used by More menu + AI surface.
  const catalogGroups = useMemo(() => {
    const bySlug = new Map<string, ExtensionInfo>();
    for (const m of busExtensions ?? []) bySlug.set(slugOf(m.id), m);
    return RAIL_CATEGORIES
      .map(({ category, slugs }) => ({
        category,
        items: slugs
          .map((slug): RailItem | null => {
            const m = bySlug.get(slug);
            if (!m) return null;
            return {
              id: `wb:${m.workbench?.id ?? slug}`,
              slug,
              category,
              label: pickLang(m.displayName, locale, slug),
              description: pickLang(m.description, locale, ''),
              manifest: m,
            };
          })
          .filter((x): x is RailItem => x !== null),
      }))
      .filter((g) => g.items.length > 0);
  }, [busExtensions, locale]);

  const allEntries = useMemo(() => catalogGroups.flatMap((g) => g.items), [catalogGroups]);

  // More-menu filter: match label / description / slug (case-insensitive).
  const filteredCatalogGroups = useMemo(() => {
    const q = moreQuery.trim().toLowerCase();
    if (!q) return catalogGroups;
    return catalogGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          item.label.toLowerCase().includes(q)
          || item.description.toLowerCase().includes(q)
          || item.slug.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [catalogGroups, moreQuery]);

  // Middle rail: pinned plugins only, ordered to match the More-menu catalog
  // (3D → 2D → general), not pin-click time.
  const pinnedSet = useMemo(() => new Set(pinnedSlugs), [pinnedSlugs]);
  const pinnedEntries = useMemo(
    () => allEntries.filter((item) => pinnedSet.has(item.slug)),
    [allEntries, pinnedSet],
  );

  const allEntriesRef = useRef(allEntries);
  allEntriesRef.current = allEntries;

  const togglePin = useCallback((slug: string) => {
    setPinnedSlugs((prev) => {
      const next = prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug];
      writePinnedSlugs(next);
      return next;
    });
  }, []);

  const entriesSlim = useMemo<HostSidebarSnapshot['entries']>(
    () => [
      { id: 'agents', label: 'Agents', kind: 'builtin' },
      ...allEntries.map((e) => ({ id: e.id, label: e.label, kind: 'bus' as const })),
    ],
    [allEntries],
  );
  const railSurface = useSurface<HostSidebarSnapshot, Record<string, UISurfaceActionDef>>({
    id: 'host.sidebar',
    layer: 'host',
    schema: HOST_SIDEBAR_SCHEMA as unknown as Record<string, unknown>,
    initialSnapshot: { workbenchTab, mode, entries: entriesSlim },
    actions: {
      selectTab: {
        id: 'selectTab',
        argsSchema: { type: 'object', required: ['tab'], properties: { tab: { type: 'string' } } },
        run: (raw) => {
          const a = (raw ?? {}) as { tab?: unknown };
          if (typeof a.tab !== 'string') return;
          setActiveWorkbench('ai');
          const entry = allEntriesRef.current.find((e) => e.id === a.tab);
          const manifest = entry?.manifest ?? null;
          useShellStore.getState().openWorkbench({
            tab: a.tab,
            expandedExtensionId: manifest && extensionRendersInMainArea(manifest) ? manifest.id : null,
          });
        },
      },
      setMode: {
        id: 'setMode',
        argsSchema: {
          type: 'object',
          required: ['mode'],
          properties: { mode: { type: 'string', enum: ['scene', 'ai'] } },
        },
        run: (raw) => {
          const a = (raw ?? {}) as { mode?: unknown };
          if (a.mode === 'scene' || a.mode === 'ai') {
            setActiveWorkbench(a.mode);
          }
        },
      },
    },
  });

  useEffect(() => {
    railSurface.setSnapshot({ workbenchTab, mode, entries: entriesSlim });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbenchTab, mode, entriesSlim]);

  const openEditor = () => { setActiveWorkbench('scene'); };
  const openAgents = () => { void railSurface.dispatch('selectTab', { tab: 'agents' }); };
  const openPlugin = (id: string) => { void railSurface.dispatch('selectTab', { tab: id }); };

  const editorActive = mode === 'scene';
  const agentsActive = mode === 'ai' && workbenchTab === 'agents';
  const activePinned = mode === 'ai' && pinnedEntries.some((e) => e.id === workbenchTab);
  const moreActive = mode === 'ai' && !agentsActive
    && allEntries.some((e) => e.id === workbenchTab) && !activePinned;

  // Roving keyboard nav over the pinned plugin buttons.
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    const n = pinnedEntries.length;
    if (n === 0) return;
    let target = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') target = (idx + 1) % n;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') target = (idx - 1 + n) % n;
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = n - 1;
    else return;
    e.preventDefault();
    openPlugin(pinnedEntries[target]!.id);
    tabRefs.current[target]?.focus();
  };

  return (
    <TooltipProvider delayDuration={260} skipDelayDuration={80}>
      <nav
        className="activity-rail thin-scrollbar"
        role="tablist"
        aria-orientation="vertical"
        aria-label={t('sidebar.workbenchExtensionsHint')}
        data-fx-slot="ActivityRail"
      >
      <div className="activity-rail-group">
        <button
          type="button"
          className={`activity-rail-item${editorActive ? ' active' : ''}`}
          onClick={openEditor}
          title={t('sidebar.editor')}
          aria-label={t('sidebar.editor')}
          role="tab"
          aria-selected={editorActive}
          data-rail-action="editor"
        >
          <span className="activity-rail-item-ic" aria-hidden><Box size={22} strokeWidth={1.7} /></span>
          <span className="activity-rail-item-lb">{t('sidebar.editor')}</span>
        </button>
        <button
          type="button"
          className={`activity-rail-item${agentsActive ? ' active' : ''}`}
          onClick={openAgents}
          title="Agents"
          aria-label="Agents"
          role="tab"
          aria-selected={agentsActive}
          data-rail-action="agents"
        >
          <span className="activity-rail-item-ic" aria-hidden><Bot size={22} strokeWidth={1.7} /></span>
          <span className="activity-rail-item-lb">Agents</span>
        </button>
      </div>

      {pinnedEntries.length > 0 && (
        <div className="activity-rail-group" data-category="pinned">
          {pinnedEntries.map((item, flatIdx) => {
            const active = mode === 'ai' && workbenchTab === item.id;
            const Icon = iconForWorkbenchModule({ workbenchId: item.id, label: item.label, extensionId: item.manifest.id });
            return (
              <Tooltip key={item.id}>
                <TooltipTrigger asChild>
                  <button
                    ref={(el) => { tabRefs.current[flatIdx] = el; }}
                    type="button"
                    className={`activity-rail-item${active ? ' active' : ''}`}
                    onClick={() => openPlugin(item.id)}
                    onKeyDown={(ev) => onTabKey(ev, flatIdx)}
                    role="tab"
                    aria-selected={active}
                    tabIndex={active ? 0 : -1}
                    aria-label={item.label}
                    data-extension-id={item.manifest.id}
                  >
                    <span className="activity-rail-item-ic" aria-hidden><Icon size={22} strokeWidth={1.7} /></span>
                    <span className="activity-rail-item-lb">{item.label}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  side="right"
                  align="start"
                  sideOffset={10}
                  className="activity-rail-plugin-tip"
                >
                  <div className="activity-rail-plugin-tip-title">{item.label}</div>
                  <div className="activity-rail-plugin-tip-category">
                    {t(`sidebar.categories.${item.category}`)}
                  </div>
                  {item.description ? (
                    <div className="activity-rail-plugin-tip-description">{item.description}</div>
                  ) : null}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      )}

      {/* More stays fixed at the bottom. */}
      <div className="activity-rail-group activity-rail-group--more">
        <Popover
          open={moreOpen}
          onOpenChange={(open) => {
            setMoreOpen(open);
            if (!open) setMoreQuery('');
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              className={`activity-rail-item${moreOpen || moreActive ? ' active' : ''}`}
              title={t('sidebar.morePluginsHint')}
              aria-label={t('sidebar.morePluginsHint')}
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              data-rail-action="more-plugins"
            >
              <span className="activity-rail-item-ic" aria-hidden><MoreHorizontal size={22} strokeWidth={1.7} /></span>
              <span className="activity-rail-item-lb">{t('sidebar.morePlugins')}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="right"
            align="end"
            sideOffset={10}
            className="activity-rail-more"
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              moreSearchRef.current?.focus();
            }}
          >
            <div className="activity-rail-more-hd">{t('sidebar.morePlugins')}</div>
            <div className="activity-rail-more-search">
              <Search size={14} strokeWidth={1.8} aria-hidden />
              <input
                ref={moreSearchRef}
                type="search"
                className="activity-rail-more-search-input"
                value={moreQuery}
                onChange={(e) => setMoreQuery(e.target.value)}
                placeholder={t('sidebar.searchPlugins')}
                aria-label={t('sidebar.searchPlugins')}
              />
            </div>
            <div className="activity-rail-more-body thin-scrollbar">
              {filteredCatalogGroups.length === 0 ? (
                <div className="activity-rail-more-empty">{t('sidebar.noMatchingPlugins')}</div>
              ) : filteredCatalogGroups.map((group) => (
                <div className="activity-rail-more-sec" key={group.category}>
                  <div className="activity-rail-more-sec-hd">{t(`sidebar.categories.${group.category}`)}</div>
                  {group.items.map((item) => {
                    const pinned = pinnedSet.has(item.slug);
                    const active = mode === 'ai' && workbenchTab === item.id;
                    const Icon = iconForWorkbenchModule({
                      workbenchId: item.id,
                      label: item.label,
                      extensionId: item.manifest.id,
                    });
                    return (
                      <div
                        key={item.id}
                        className={`activity-rail-more-row${active ? ' active' : ''}${pinned ? ' pinned' : ''}`}
                      >
                        <button
                          type="button"
                          className="activity-rail-more-open"
                          onClick={() => {
                            openPlugin(item.id);
                            setMoreOpen(false);
                          }}
                          title={item.description || item.label}
                        >
                          <span className="activity-rail-more-ic" aria-hidden>
                            <Icon size={16} strokeWidth={1.7} />
                          </span>
                          <span className="activity-rail-more-meta">
                            <span className="activity-rail-more-name">{item.label}</span>
                            {item.description ? (
                              <span className="activity-rail-more-desc">{item.description}</span>
                            ) : null}
                          </span>
                        </button>
                        <button
                          type="button"
                          className={`activity-rail-more-pin${pinned ? ' on' : ''}`}
                          onClick={() => togglePin(item.slug)}
                          title={pinned ? t('sidebar.unpinPlugin') : t('sidebar.pinPlugin')}
                          aria-label={pinned ? t('sidebar.unpinPlugin') : t('sidebar.pinPlugin')}
                          aria-pressed={pinned}
                        >
                          <Pin size={14} strokeWidth={pinned ? 2.2 : 1.6} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      </nav>
    </TooltipProvider>
  );
}
