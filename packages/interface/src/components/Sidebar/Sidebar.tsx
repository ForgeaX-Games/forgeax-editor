import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Bot, Files, PanelLeftClose, PanelLeftOpen, Wrench, ExternalLink, PictureInPicture2 } from 'lucide-react';
import { useAppStore } from '../../store';
import { getWindowManager, surfaceKey, type SurfaceDescriptor } from '../../lib/platform';
import { AgentsPanel } from './AgentsPanel';
import { FilesPanel } from './FilesPanel';
import { listBusPlugins, pickLang, type BusPluginInfo } from '../../lib/bus-api';
import { useSurface, type UISurfaceActionDef } from '../../lib/surface';
import { pluginRendersInMainArea, pluginRendersInSidebarLeftPane } from '../MainArea/WorkbenchPluginHost';
import { KeepAlivePluginIframes } from '../MainArea/KeepAlivePluginIframes';
import { iconForWorkbenchModule } from '../../lib/workbench-module-icons';
import { useTranslation, getLocale } from '@/i18n';
import './Sidebar.css';

// Phase B4 — the static `PLUGIN_PANEL_LOADERS` import map is gone. Plugins
// that want to render in the Sidebar's left pane declare
// `workbench.panes.left` + `entry.standalone` in their manifest, and we
// mount them through `StandalonePluginIframe pane="left"` — mirroring the
// MainArea path in `WorkbenchPluginHost.tsx`. Anything without an iframe
// surface falls through to `BusPluginPlaceholder`.
// Cross-references:
//   - manifest sample: packages/marketplace/plugins/wb-character/forgeax-plugin.json
//   - host helper:     pluginRendersInSidebarLeftPane (MainArea/WorkbenchPluginHost)
//   - server route:    packages/server/src/main.ts → /plugins/<id>/* serveStatic

// P2.6a — the WORKBENCH icons row is two segments stitched together:
//
//   [built-in tabs] + [bus-sourced workbench plugins]
//
// Built-in tabs (Agents/Files) wire real panels. Bus-sourced rows come from
// `GET /api/bus/plugins?kind=workbench` and render the manifest's emoji icon +
// displayName.zh; clicking one shows the description.zh in the right pane as
// a richer placeholder. When the bus call fails we fall back to a small set of
// hardcoded labels so the UI still looks alive — this matches the v3 KPI of
// "never let the workbench row look empty."
//
// Cross-references:
//   - server: packages/server/src/api/bus.ts → createBusRouter
//   - lib:    packages/interface/src/lib/bus-api.ts → listBusPlugins
//   - spec:   forgeax-dev-diary/2026-05-15/modules/10-workbench-spec.md

type BuiltinId = 'agents' | 'files';

interface BuiltinEntry {
  kind: 'builtin';
  id: BuiltinId;
  label: string;
  Icon: typeof Bot;
}

interface BusEntry {
  kind: 'bus';
  // wb:<workbench.id>  — namespaced so it never collides with a builtin tab id.
  id: string;
  label: string;
  emoji: string;
  manifest: BusPluginInfo;
}

type Entry = BuiltinEntry | BusEntry;

const BUILTINS: BuiltinEntry[] = [
  { kind: 'builtin', id: 'agents', label: 'Agents', Icon: Bot },
  { kind: 'builtin', id: 'files', label: 'Files', Icon: Files },
];

// Final fallback when the bus endpoint is unreachable (e.g. server boot lag
// or a regression in scan). Keeps the legacy 5 placeholder tabs labeled in zh
// so the UI never collapses to just Agents/Files.
const FALLBACK_WBS: Array<Pick<BusPluginInfo, 'id' | 'icon' | 'displayName'> & { workbench: NonNullable<BusPluginInfo['workbench']> }> = [
  { id: 'fallback-character', icon: undefined, displayName: { en: 'Character / Narrative', zh: '角色叙事' }, workbench: { id: 'character', icon: '👤', position: 110 } },
  { id: 'fallback-scene', icon: undefined, displayName: { en: 'Scene / PCG', zh: '场景 / PCG' }, workbench: { id: 'scene', icon: '🗺️', position: 180 } },
  { id: 'fallback-skill', icon: undefined, displayName: { en: 'Skill / VFX', zh: '技能 / VFX' }, workbench: { id: 'skill', icon: '⚡', position: 140 } },
  { id: 'fallback-look', icon: undefined, displayName: { en: 'Color / Look', zh: '色彩 / Look' }, workbench: { id: 'look', icon: '🎨', position: 120 } },
  { id: 'fallback-library', icon: undefined, displayName: { zh: 'Library' }, workbench: { id: 'library', icon: '🖼️', position: 200 } },
];

// 2026-05-17 — `KIND_LABELS` 与 SidebarKindFooter 一起删除。bus-kind 计数
// 现在仅由底栏 GlobalStatusBar.PulseFeeds 显示。

// P9 dual-modality — schema 给 AI 看 (DUAL-MODALITY-UI.md §四). 这里 inline 描述,
// 后续叠 ajv 校验时再外置 ./surfaces/sidebar.schema.json. 字段名跟 snapshot
// 一一对应, AI 拿到这份 schema 就能学到 selectTab / setMode 的合法值域.
const HOST_SIDEBAR_SCHEMA = {
  type: 'object',
  properties: {
    workbenchTab: { type: 'string', description: 'Currently active workbench tab id (e.g. agents, files, wb:character)' },
    mode: { type: 'string', enum: ['preview', 'workbench', 'edit', 'bus'] },
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
  mode: 'preview' | 'workbench' | 'edit' | 'bus';
  entries: Array<{ id: string; label: string; kind: 'builtin' | 'bus' }>;
}

export function Sidebar() {
  const { t } = useTranslation();
  const { workbenchTab, setWorkbenchTab } = useAppStore();
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
  const openSettings = useAppStore((s) => s.openSettings);
  const setPendingBusKindFilter = useAppStore((s) => s.setPendingBusKindFilter);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const floatingSurfaces = useAppStore((s) => s.floatingSurfaces);
  const detachSurface = useAppStore((s) => s.detachSurface);
  const redockSurface = useAppStore((s) => s.redockSurface);
  // Plugins currently open as top-level DockShell panels — their iframes are
  // rendered in that panel, so KeepAlivePluginIframes skips them here.
  const dockedPlugins = useAppStore((s) => s.dockedPlugins);

  const [busPlugins, setBusPlugins] = useState<BusPluginInfo[] | null>(null);
  const [busError, setBusError] = useState<string | null>(null);

  // Sidebar is a persistent component (it does not remount on tab switches),
  // so a single failed boot-time fetch would pin FALLBACK_WBS — which lacks
  // `entry.standalone` — for the whole session, leaving left-pane plugins
  // permanently un-mountable. Retry a few times before giving up.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const MAX_ATTEMPTS = 10;
    const RETRY_MS = 1500;

    const load = () => {
      attempts += 1;
      listBusPlugins('workbench')
        .then((res) => {
          if (cancelled) return;
          setBusPlugins(res.items);
          setBusError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const msg = err instanceof Error ? err.message : String(err);
          setBusError(msg);
          if (attempts >= MAX_ATTEMPTS) {
            setBusPlugins([]);
            return;
          }
          timer = setTimeout(load, RETRY_MS);
        });
    };
    load();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const busEntries = useMemo<BusEntry[]>(() => {
    const source = busPlugins && busPlugins.length > 0 ? busPlugins : (busError ? FALLBACK_WBS as BusPluginInfo[] : []);
    return source
      .filter((m) => !m.workbench?.hidden)
      .map<BusEntry>((m) => ({
        kind: 'bus',
        id: `wb:${m.workbench?.id ?? m.id}`,
        label: pickLang(m.displayName, getLocale(), m.workbench?.id ?? m.id),
        emoji: m.workbench?.icon ?? m.icon ?? '🧩',
        manifest: m,
      }));
  }, [busPlugins, busError]);

  const entries: Entry[] = useMemo(() => [...BUILTINS, ...busEntries], [busEntries]);
  useEffect(() => {
    if (!busPlugins || busPlugins.length === 0) return;
    if (workbenchTab === 'agents' || workbenchTab === 'files') return;
    if (entries.some((e) => e.id === workbenchTab)) return;
    const next = busEntries[0]?.id;
    if (next) setWorkbenchTab(next);
  }, [busEntries, busPlugins, entries, setWorkbenchTab, workbenchTab]);

  const activeIdx = useMemo(() => {
    const i = entries.findIndex((e) => e.id === workbenchTab);
    return i >= 0 ? i : 0;
  }, [entries, workbenchTab]);
  const activeEntry = entries[activeIdx];
  // The left-pane standalone plugin to show right now (or null). Fed to the
  // keep-alive overlay so switching wb tabs only flips visibility instead of
  // unmounting/reloading the iframe.
  const leftPaneActivePlugin = useMemo<BusPluginInfo | null>(
    () =>
      activeEntry?.kind === 'bus' && pluginRendersInSidebarLeftPane(activeEntry.manifest)
        ? activeEntry.manifest
        : null,
    [activeEntry],
  );
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  // Track last wb:* tab so clicking ToolCase nav returns to it
  const lastWbTabRef = useRef<string>('');
  useEffect(() => {
    if (workbenchTab !== 'agents' && workbenchTab !== 'files') {
      lastWbTabRef.current = workbenchTab;
    }
  }, [workbenchTab]);

  // Derive top-level nav tab (agents / files / workbench)
  const navTab: 'agents' | 'files' | 'workbench' =
    workbenchTab === 'agents' ? 'agents'
    : workbenchTab === 'files' ? 'files'
    : 'workbench';

  const sidebarEntriesSlim = useMemo<HostSidebarSnapshot['entries']>(
    () => entries.map((e) => ({ id: e.id, label: e.label, kind: e.kind })),
    [entries],
  );
  const sidebarSurface = useSurface<HostSidebarSnapshot, Record<string, UISurfaceActionDef>>({
    id: 'host.sidebar',
    layer: 'host',
    schema: HOST_SIDEBAR_SCHEMA as unknown as Record<string, unknown>,
    initialSnapshot: { workbenchTab, mode, entries: sidebarEntriesSlim },
    actions: {
      selectTab: {
        id: 'selectTab',
        argsSchema: { type: 'object', required: ['tab'], properties: { tab: { type: 'string' } } },
        run: (raw) => {
          const a = (raw ?? {}) as { tab?: unknown };
          if (typeof a.tab !== 'string') return;
          // Atomic open — sets tab + center together so the sidebar left pane
          // and the center can never desync (architecture review §B3).
          const entry = entriesRef.current.find((e) => e.id === a.tab);
          const manifest = entry?.kind === 'bus' ? entry.manifest : null;
          useAppStore.getState().openWorkbench({
            tab: a.tab,
            expandedPluginId: manifest && pluginRendersInMainArea(manifest) ? manifest.id : null,
          });
        },
      },
      setMode: {
        id: 'setMode',
        argsSchema: {
          type: 'object',
          required: ['mode'],
          properties: { mode: { type: 'string', enum: ['preview', 'workbench', 'edit', 'bus'] } },
        },
        run: (raw) => {
          const a = (raw ?? {}) as { mode?: unknown };
          if (a.mode === 'preview' || a.mode === 'workbench' || a.mode === 'edit' || a.mode === 'bus') {
            useAppStore.getState().setMode(a.mode);
          }
        },
      },
    },
  });

  useEffect(() => {
    sidebarSurface.setSnapshot({ workbenchTab, mode, entries: sidebarEntriesSlim });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbenchTab, mode, sidebarEntriesSlim]);

  // Keyboard nav for the ws-icons-row (bus entries only, offset by BUILTINS.length)
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, busIdx: number) => {
    if (busEntries.length === 0) return;
    let target = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      target = (busIdx + 1) % busEntries.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      target = (busIdx - 1 + busEntries.length) % busEntries.length;
    } else if (e.key === 'Home') {
      target = 0;
    } else if (e.key === 'End') {
      target = busEntries.length - 1;
    } else {
      return;
    }
    e.preventDefault();
    void sidebarSurface.dispatch('selectTab', { tab: busEntries[target].id });
    tabRefs.current[target + BUILTINS.length]?.focus();
  };

  const handleNavWorkbench = () => {
    const target = lastWbTabRef.current || (busEntries[0]?.id ?? '');
    if (target) void sidebarSurface.dispatch('selectTab', { tab: target });
  };

  // ── Collapsed state: 36px vertical icon strip ──────────────────────────
  if (sidebarCollapsed) {
    return (
      <aside className="sidebar sidebar-collapsed">
        <div className="sb-toolbar-collapsed">
          <button className="sb-icon-btn" onClick={toggleSidebar} title={t('sidebar.expandSidebar')} aria-label={t('sidebar.expandSidebar')}>
            <PanelLeftOpen size={16} />
          </button>
          <div className="sb-nav-divider" />
          <div className="sb-nav-icons-v">
            <button
              className={`sb-icon-btn ${navTab === 'agents' ? 'active' : ''}`}
              onClick={() => void sidebarSurface.dispatch('selectTab', { tab: 'agents' })}
              aria-label="Agents" data-tip="Agents"
            >
              <Bot size={16} />
            </button>
            <button
              className={`sb-icon-btn ${navTab === 'files' ? 'active' : ''}`}
              onClick={() => void sidebarSurface.dispatch('selectTab', { tab: 'files' })}
              aria-label="Files" data-tip="Files"
            >
              <Files size={16} />
            </button>
            <button
              className={`sb-icon-btn ${navTab === 'workbench' ? 'active' : ''}`}
              onClick={handleNavWorkbench}
              aria-label="Workbench" data-tip="Workbench"
            >
              <Wrench size={16} />
            </button>
          </div>
        </div>
      </aside>
    );
  }

  // ── Expanded state ──────────────────────────────────────────────────────
  return (
    <aside className="sidebar thin-scrollbar">
      {/* Top toolbar: 3 nav buttons (left) + collapse button (right) */}
      <div className="sb-toolbar">
        <div className="sb-nav-icons-h">
          <button
            className={`sb-icon-btn ${navTab === 'agents' ? 'active' : ''}`}
            onClick={() => void sidebarSurface.dispatch('selectTab', { tab: 'agents' })}
            aria-label="Agents" data-tip="Agents"
          >
            <Bot size={16} />
          </button>
          <button
            className={`sb-icon-btn ${navTab === 'files' ? 'active' : ''}`}
            onClick={() => void sidebarSurface.dispatch('selectTab', { tab: 'files' })}
            aria-label="Files" data-tip="Files"
          >
            <Files size={16} />
          </button>
          <button
            className={`sb-icon-btn ${navTab === 'workbench' ? 'active' : ''}`}
            onClick={handleNavWorkbench}
            aria-label="Workbench" data-tip="Workbench"
          >
            <Wrench size={16} />
          </button>
        </div>
        <button className="sb-icon-btn" onClick={toggleSidebar} title={t('sidebar.collapseSidebar')} aria-label={t('sidebar.collapseSidebar')}>
          <PanelLeftClose size={16} />
        </button>
      </div>

      <div className="ss-section workbench">
        {/* Bus plugin sub-nav — only visible when Workbench tab is active */}
        {navTab === 'workbench' && busEntries.length > 0 && (
          <div
            className="ws-icons-row"
            aria-label="Workbench plugins"
          >
            <div
              className="ws-icons-pill"
              role="tablist"
              aria-orientation="horizontal"
              title={t('sidebar.workbenchPluginsHint')}
            >
            {busEntries.map((e, i) => {
              const globalIdx = i + BUILTINS.length;
              const active = globalIdx === activeIdx;
              return (
                <button
                  key={e.id}
                  ref={(el) => { tabRefs.current[globalIdx] = el; }}
                  className={`ws-icon-btn ${active ? 'active' : ''} bus`}
                  onClick={() => void sidebarSurface.dispatch('selectTab', { tab: e.id })}
                  onKeyDown={(ev) => onTabKey(ev, i)}
                  role="tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  title={t('sidebar.tabTooltip', { label: e.label, id: e.manifest.id })}
                  aria-label={e.label}
                  data-plugin-id={e.manifest.id}
                >
                  {(() => { const Icon = iconForWorkbenchModule({ workbenchId: e.id, label: e.label, pluginId: e.manifest.id }); return <Icon size={16} />; })()}

                </button>
              );
            })}
            </div>
          </div>
        )}
        <div key={activeEntry?.id ?? 'empty'} className="ws-active-content rail-panel">
          {activeEntry?.kind === 'builtin' && (activeEntry.id === 'agents' || activeEntry.id === 'files') ? (
            (() => {
              // Built-in panels (Agents/Files) are pop-out-able too — DetachedSurface
              // hosts them as `panel` surfaces; this adds the missing affordance so
              // they float into their own OS window like the plugin panes do.
              const desc: SurfaceDescriptor = { kind: 'panel', id: activeEntry.id };
              const floating = !!floatingSurfaces[surfaceKey(desc)];
              if (floating) {
                return (
                  <div className="ws-pane-floating">
                    <span>{t('sidebar.inSeparateWindow')}</span>
                    <button className="ws-pane-window-toggle" onClick={() => void redockSurface(desc)} title={t('sidebar.redockToMainWindow')}>
                      <PictureInPicture2 size={12} />
                    </button>
                  </div>
                );
              }
              return (
                <>
                  {getWindowManager().canDetach() && (
                    <button
                      className="ws-pane-window-toggle floating-trigger"
                      onClick={() => void detachSurface(desc, { title: activeEntry.label })}
                      title={t('sidebar.popOutToSeparateWindow')}
                    >
                      <ExternalLink size={12} />
                    </button>
                  )}
                  {activeEntry.id === 'agents' ? <AgentsPanel /> : <FilesPanel />}
                </>
              );
            })()
          ) : activeEntry?.kind === 'bus' ? (
            // Doc 06 §panes — if the plugin declares both `entry.standalone`
            // and `workbench.panes.left`, its `?pane=left` iframe is rendered
            // by the keep-alive overlay below (so switching wb tabs doesn't
            // reload it). Without explicit left intent we render the
            // BusPluginPlaceholder info card.
            pluginRendersInSidebarLeftPane(activeEntry.manifest) ? null : (
              <BusPluginPlaceholder entry={activeEntry} siblingCount={busEntries.length} />
            )
          ) : (
            <ToolPlaceholder label={activeEntry?.label ?? ''} sub="Coming soon" />
          )}
          {/* Keep-alive overlay for left-pane standalone plugins. Always
              mounted (Sidebar is persistent) so visited left-pane iframes
              survive tab switches; only visibility flips. */}
          <div
            className={`ws-pane-keepalive${leftPaneActivePlugin ? ' active' : ''}`}
            style={leftPaneActivePlugin ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
            aria-hidden={leftPaneActivePlugin ? undefined : true}
          >
            {(() => {
              if (!leftPaneActivePlugin || !getWindowManager().canDetach()) return null;
              const desc: SurfaceDescriptor = { kind: 'plugin', id: leftPaneActivePlugin.id, pane: 'left' };
              const floating = !!floatingSurfaces[surfaceKey(desc)];
              const label = pickLang(leftPaneActivePlugin.displayName, getLocale(), leftPaneActivePlugin.id);
              return floating ? (
                <div className="ws-pane-floating">
                  <span>{t('sidebar.inSeparateWindow')}</span>
                  <button className="ws-pane-window-toggle" onClick={() => void redockSurface(desc)} title={t('sidebar.redockToMainWindow')}>
                    <PictureInPicture2 size={12} />
                  </button>
                </div>
              ) : (
                <button
                  className="ws-pane-window-toggle floating-trigger"
                  onClick={() => void detachSurface(desc, { title: label })}
                  title={t('sidebar.popOutToSeparateWindow')}
                >
                  <ExternalLink size={12} />
                </button>
              );
            })()}
            {leftPaneActivePlugin && dockedPlugins.has(leftPaneActivePlugin.id) ? (
              <div className="ws-pane-floating">
                <span>{t('sidebar.inDockPanel')}</span>
              </div>
            ) : (
              <KeepAlivePluginIframes pane="left" activePlugin={leftPaneActivePlugin} floatingKeys={floatingSurfaces} />
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

// P2.7f — placeholder grows from "emoji + title + desc + 3 tag" into a small
// info card the player can actually read off: manifest filesystem path (so
// they know which file to edit), a 2x2 meta grid (kind / version / position
// / panelSize), and a deep-link button that switches the top-level mode to
// 'bus' AND seeds store.pendingBusExpandId so BusAdminPanel auto-expands the
// matching row + scrolls to it. Forms a Sidebar wb-* tab ⇄ Bus admin detail
// navigation closure (sibling to P2.6f row expand).
//
// P2.7h — under the zh description we also render description.en in a smaller
// italic muted line. Same family as P2.7c (agent produces) / P2.7g (cli
// description) — manifest fields previously hidden in title-tooltips get
// promoted to default-visible mini-strips. i18n readers (en) no longer have
// to read the Chinese line first.
function BusPluginPlaceholder({ entry, siblingCount }: { entry: BusEntry; siblingCount: number }) {
  const { t } = useTranslation();
  const m = entry.manifest;
  const description = pickLang(m.description, 'zh', '');
  const descriptionEn = pickLang(m.description, 'en', '');
  const showEn = descriptionEn && descriptionEn !== description;
  const setMode = useAppStore((s) => s.setMode);
  const setPendingBusExpandId = useAppStore((s) => s.setPendingBusExpandId);
  const setPendingBusKindFilter = useAppStore((s) => s.setPendingBusKindFilter);
  const openSettingsStore = useAppStore((s) => s.openSettings);
  const dir = m.id.startsWith('@forgeax-plugin/')
    ? m.id.slice('@forgeax-plugin/'.length)
    : m.id;
  const manifestPath = `packages/marketplace/plugins/${dir}/manifest.json`;
  const openInBus = () => {
    setPendingBusExpandId(m.id);
    openSettingsStore('plugins');
  };
  // P4.99 — click jumps to Bus admin AND solos kind=workbench so the player
  // immediately sees all sibling workbench plugins side by side. Reuses
  // pendingBusKindFilter pipeline (P3.37 / P3.83) — same deep-link as the
  // composer cb-mbsel-arrow (P3.47) and Analytics kind chips. Position cell
  // above already tells you "I'm #N in the row"; this row answers "who are
  // the other N-1 siblings?" — one click and Bus admin shows them all.
  const openSiblings = () => {
    setPendingBusKindFilter('workbench');
    setPendingBusExpandId(m.id);
    openSettingsStore('plugins');
  };
  return (
    <div className="tool-placeholder bus-tool">
      <div className="bus-tool-hero">
        {(() => { const Icon = iconForWorkbenchModule({ workbenchId: entry.id, label: entry.label, pluginId: entry.manifest.id }); return <Icon size={30} className="bus-tool-icon" aria-hidden />; })()}
        <div className="bus-tool-headings">
          <div className="bus-tool-title">{entry.label}</div>
          <div className="bus-tool-pluginid">{m.id}@{m.version}</div>
        </div>
      </div>
      {description ? <div className="bus-tool-desc">{description}</div> : null}
      {showEn ? <div className="bus-tool-desc-en" lang="en">{descriptionEn}</div> : null}
      <div className="bus-tool-grid">
        <div className="bus-tool-cell">
          <div className="bus-tool-cell-label">kind</div>
          <div className={`bus-tool-cell-value k-${m.kind}`}>{m.kind}</div>
        </div>
        <div className="bus-tool-cell">
          <div className="bus-tool-cell-label">version</div>
          <div className="bus-tool-cell-value mono">{m.version}</div>
        </div>
        {typeof m.workbench?.position === 'number' && (
          <div className="bus-tool-cell">
            <div className="bus-tool-cell-label">position</div>
            <div className="bus-tool-cell-value mono">{m.workbench.position}</div>
          </div>
        )}
        {m.workbench?.panelSize && (
          <div className="bus-tool-cell">
            <div className="bus-tool-cell-label">panelSize</div>
            <div className="bus-tool-cell-value mono">{m.workbench.panelSize}</div>
          </div>
        )}
      </div>
      {/* P4.98 — provides.{tools,events,skills} stat strip. Closes the
         info-island from icon to panel: corner badges T/E (P4.89/P4.90)
         showed counts at icon scale; this surfaces them legible inside
         the open panel, plus skills (no icon-scale slot left). Pill colors
         mirror BusAdminPanel .ba-prov-tag (orange tools / pink events /
         purple skills) so player learns one cross-surface palette. When
         all three are zero the strip still renders with a muted "未声明
         provides" hint so every workbench tab gains an equal-height row
         — 12 tabs, 12 different reveal moments. */}
      <div
        className={`bus-tool-provides ${
          (m.tools?.length ?? 0) + (m.events?.length ?? 0) + (m.skills?.length ?? 0) === 0
            ? 'empty'
            : ''
        }`}
      >
        <div className="bus-tool-cell-label">provides to AI</div>
        <div className="bus-tool-provides-pills">
          {(m.tools?.length ?? 0) > 0 ? (
            <span
              className="bus-tool-prov k-tool"
              title={t('sidebar.providesToolsTooltip', { count: m.tools!.length, list: m.tools!.map((tool) => tool.id).join(' · ') })}
            >
              T<b>{m.tools!.length}</b> tools
            </span>
          ) : (
            <span className="bus-tool-prov k-tool muted" title={t('sidebar.providesNoTools')}>T0 tools</span>
          )}
          {(m.events?.length ?? 0) > 0 ? (
            <span
              className="bus-tool-prov k-event"
              title={t('sidebar.providesEventsTooltip', { count: m.events!.length, list: m.events!.map((e) => e.name).join(' · ') })}
            >
              E<b>{m.events!.length}</b> events
            </span>
          ) : (
            <span className="bus-tool-prov k-event muted" title={t('sidebar.providesNoEvents')}>E0 events</span>
          )}
          {(m.skills?.length ?? 0) > 0 ? (
            <span
              className="bus-tool-prov k-skill"
              title={t('sidebar.providesSkillsTooltip', { count: m.skills!.length, list: m.skills!.map((s) => s.id).join(' · ') })}
            >
              S<b>{m.skills!.length}</b> skills
            </span>
          ) : (
            <span className="bus-tool-prov k-skill muted" title={t('sidebar.providesNoSkills')}>S0 skills</span>
          )}
        </div>
      </div>
      <div className="bus-tool-manifest">
        <div className="bus-tool-cell-label">manifest</div>
        <code className="bus-tool-manifest-path" title={manifestPath}>
          {manifestPath}
        </code>
      </div>
      {/* P4.99 — discoverability row. The grid above tells you "I'm position N";
         this tells you "the kind family has M siblings on the bus" and the
         arrow deep-links to Bus admin solo'd by kind=workbench. Same affordance
         shape as cb-mbsel arrow (P3.47) and BusAdminPanel kind tag (P4.96):
         one click jumps surface + applies kind solo filter. Visible on all
         10+ wb-* placeholder tabs as a brand-new cyan-tinted clickable row. */}
      <button
        type="button"
        className="bus-tool-family"
        onClick={openSiblings}
        title={t('sidebar.familyTooltip', { count: siblingCount })}
      >
        <span className="bus-tool-family-icon" aria-hidden>🧩</span>
        <span className="bus-tool-family-label">family</span>
        <span className="bus-tool-family-text">
          <b>{siblingCount}</b> workbench plugins on bus
        </span>
        <span className="bus-tool-family-arrow" aria-hidden>→</span>
      </button>
      <div className="bus-tool-meta">
        <span className={`bus-tool-tag ${m.experimental ? 'experimental' : ''}`}>
          {m.experimental ? 'experimental' : 'stable'}
        </span>
        {m.workbench?.hidden && <span className="bus-tool-tag warn">hidden</span>}
      </div>
      <button
        type="button"
        className="bus-tool-open"
        onClick={openInBus}
        title={t('sidebar.openInBusTooltip', { id: m.id })}
      >
        {t('sidebar.openInBusDetail')}
      </button>
    </div>
  );
}

function ToolPlaceholder({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="tool-placeholder">
      <div className="tp-title">{label}</div>
      <div className="tp-sub">{sub}</div>
    </div>
  );
}
