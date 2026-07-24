import { useEffect, useMemo, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen, ExternalLink, PictureInPicture2 } from 'lucide-react';
import { useShellStore } from '../../store';
import { emitDeepLink } from '../../lib/deep-link-bus';
import { getWindowManager, surfaceKey, type SurfaceDescriptor } from '../../lib/platform';
import { AgentsPanelSlot } from '../DockShell/panelRegistry';
import { extensionManifestPathHint, listExtensions, pickLang, type ExtensionInfo } from '../../lib/extension-api';
import { extensionRendersInSidebarLeftPane } from '../MainArea/WorkbenchExtensionHost';
import { KeepAliveExtensionIframes } from '../MainArea/KeepAliveExtensionIframes';
import { iconForWorkbenchModule } from '../../lib/workbench-module-icons';
import { useTranslation } from '@/i18n';
import './Sidebar.css';

// Sidebar is now the CONTENT host of the AI workbench's Tools panel: it renders
// the active tab's body (the Agents list, or a workbench plugin's left pane /
// info placeholder). Top-level navigation (编辑器 / Agents / plugins / platform)
// moved to the shell-level `ActivityRail` (Approach B), so this component holds
// no nav of its own — it just reacts to `workbenchTab`.
//
// Cross-references:
//   - nav rail:   components/ActivityRail/ActivityRail.tsx
//   - left pane:  extensionRendersInSidebarLeftPane (MainArea/WorkbenchExtensionHost)
//   - server:     packages/server/src/main.ts → /extensions/<id>/* serveStatic

type BuiltinId = 'agents';

interface BuiltinEntry {
  kind: 'builtin';
  id: BuiltinId;
  label: string;
}

interface BusEntry {
  kind: 'bus';
  // wb:<workbench.id> — namespaced so it never collides with a builtin id.
  id: string;
  label: string;
  manifest: ExtensionInfo;
}

type Entry = BuiltinEntry | BusEntry;

const BUILTINS: BuiltinEntry[] = [{ kind: 'builtin', id: 'agents', label: 'Agents' }];

export function Sidebar() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const workbenchTab = useShellStore((s) => s.workbenchTab);
  const setWorkbenchTab = useShellStore((s) => s.setWorkbenchTab);
  const sidebarCollapsed = useShellStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useShellStore((s) => s.toggleSidebar);
  const floatingSurfaces = useShellStore((s) => s.floatingSurfaces);
  const detachSurface = useShellStore((s) => s.detachSurface);
  const redockSurface = useShellStore((s) => s.redockSurface);
  // Plugins currently open as top-level DockShell panels — their iframes are
  // rendered in that panel, so KeepAliveExtensionIframes skips them here.
  const dockedExtensions = useShellStore((s) => s.dockedExtensions);

  const [busExtensions, setBusExtensions] = useState<ExtensionInfo[] | null>(null);
  // Persistent component: retry a few times so a slow boot doesn't pin the
  // content to an empty state for the whole session.
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

  // Not filtered by `hidden`: the ActivityRail's curated spec may surface a
  // manifest-hidden plugin (e.g. wb-lowpoly-obj), and this content host must be
  // able to resolve its active tab. (Nav lives in the rail now, so listing all
  // is harmless here.)
  const busEntries = useMemo<BusEntry[]>(
    () => (busExtensions ?? [])
      .map((m) => ({
        kind: 'bus',
        id: `wb:${m.workbench?.id ?? m.id}`,
        label: pickLang(m.displayName, locale, m.workbench?.id ?? m.id),
        manifest: m,
      })),
    [busExtensions, locale],
  );

  const entries: Entry[] = useMemo(() => [...BUILTINS, ...busEntries], [busEntries]);
  // Keep workbenchTab valid: if it points at a plugin no longer present (and is
  // not the builtin 'agents' tab), fall back to the first plugin.
  useEffect(() => {
    if (!busExtensions || busExtensions.length === 0) return;
    if (workbenchTab === 'agents') return;
    if (entries.some((e) => e.id === workbenchTab)) return;
    const next = busEntries[0]?.id;
    if (next) setWorkbenchTab(next);
  }, [busEntries, busExtensions, entries, setWorkbenchTab, workbenchTab]);

  const activeEntry = useMemo(
    () => entries.find((e) => e.id === workbenchTab) ?? entries[0],
    [entries, workbenchTab],
  );
  // The left-pane standalone plugin to show right now (or null). Fed to the
  // keep-alive overlay so switching wb tabs only flips visibility instead of
  // unmounting/reloading the iframe.
  const leftPaneActiveExtension = useMemo<ExtensionInfo | null>(
    () => activeEntry?.kind === 'bus' && extensionRendersInSidebarLeftPane(activeEntry.manifest)
      ? activeEntry.manifest
      : null,
    [activeEntry],
  );

  // ── Collapsed state: 36px strip (just the expand button) ────────────────
  if (sidebarCollapsed) {
    return (
      <aside className="sidebar sidebar-collapsed">
        <div className="sb-toolbar-collapsed">
          <button className="sb-icon-btn" onClick={toggleSidebar} title={t('sidebar.expandSidebar')} aria-label={t('sidebar.expandSidebar')}>
            <PanelLeftOpen size={16} />
          </button>
        </div>
      </aside>
    );
  }

  // ── Expanded state: collapse affordance + active tab content ────────────
  return (
    <aside className="sidebar thin-scrollbar">
      <div className="sb-toolbar sb-toolbar--end">
        <button className="sb-icon-btn" onClick={toggleSidebar} title={t('sidebar.collapseSidebar')} aria-label={t('sidebar.collapseSidebar')}>
          <PanelLeftClose size={16} />
        </button>
      </div>

      <div className="ss-section workbench">
        <div key={activeEntry?.id ?? 'empty'} className="ws-active-content rail-panel">
          {activeEntry?.kind === 'builtin' ? (
            (() => {
              // Agents panel is pop-out-able too — DetachedSurface hosts it as a
              // `panel` surface; this adds the affordance to float it into its own
              // OS window like the plugin panes do.
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
                  <AgentsPanelSlot />
                </>
              );
            })()
          ) : activeEntry?.kind === 'bus' ? (
            // Doc 06 §panes — if the plugin declares both `entry.standalone` and
            // `workbench.panes.left`, its `?pane=left` iframe is rendered by the
            // keep-alive overlay below. Without explicit left intent we render the
            // ExtensionPlaceholder info card.
            extensionRendersInSidebarLeftPane(activeEntry.manifest) ? null : (
              <ExtensionPlaceholder entry={activeEntry} siblingCount={busEntries.length} />
            )
          ) : null}
          {/* Keep-alive overlay for left-pane standalone plugins. Always mounted
              (Sidebar is persistent) so visited left-pane iframes survive tab
              switches; only visibility flips. */}
          <div
            className={`ws-pane-keepalive${leftPaneActiveExtension ? ' active' : ''}`}
            style={leftPaneActiveExtension ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
            aria-hidden={leftPaneActiveExtension ? undefined : true}
          >
            {(() => {
              if (!leftPaneActiveExtension || !getWindowManager().canDetach()) return null;
              const desc: SurfaceDescriptor = { kind: 'plugin', id: leftPaneActiveExtension.id, pane: 'left' };
              const floating = !!floatingSurfaces[surfaceKey(desc)];
              const label = pickLang(leftPaneActiveExtension.displayName, locale, leftPaneActiveExtension.id);
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
            {leftPaneActiveExtension && dockedExtensions.has(leftPaneActiveExtension.id) ? (
              <div className="ws-pane-floating">
                <span>{t('sidebar.inDockPanel')}</span>
              </div>
            ) : (
              <KeepAliveExtensionIframes pane="left" activeExtension={leftPaneActiveExtension} floatingKeys={floatingSurfaces} />
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
function ExtensionPlaceholder({ entry, siblingCount }: { entry: BusEntry; siblingCount: number }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const m = entry.manifest;
  const description = pickLang(m.description, locale, '');
  const descriptionAlt = pickLang(m.description, locale === 'zh' ? 'en' : 'zh', '');
  const showAlt = descriptionAlt && descriptionAlt !== description;
  const openSettingsStore = useShellStore((s) => s.openOverlay);
  const manifestPath = extensionManifestPathHint(m.id);
  const openInBus = () => {
    emitDeepLink('bus:expand-plugin', m.id);
    openSettingsStore('settings', 'plugins');
  };
  // P4.99 — click jumps to Bus admin AND solos kind=workbench so the player
  // immediately sees all sibling workbench plugins side by side. Reuses
  // pendingBusKindFilter pipeline (P3.37 / P3.83) — same deep-link as the
  // composer cb-mbsel-arrow (P3.47) and Analytics kind chips. Position cell
  // above already tells you "I'm #N in the row"; this row answers "who are
  // the other N-1 siblings?" — one click and Bus admin shows them all.
  const openSiblings = () => {
    emitDeepLink('bus:filter-kind', 'workbench');
    emitDeepLink('bus:expand-plugin', m.id);
    openSettingsStore('settings', 'plugins');
  };
  return (
    <div className="tool-placeholder bus-tool">
      <div className="bus-tool-hero">
        {(() => { const Icon = iconForWorkbenchModule({ workbenchId: entry.id, label: entry.label, extensionId: entry.manifest.id }); return <Icon size={30} className="bus-tool-icon" aria-hidden />; })()}
        <div className="bus-tool-headings">
          <div className="bus-tool-title">{entry.label}</div>
          <div className="bus-tool-pluginid">{m.id}@{m.version}</div>
        </div>
      </div>
      {description ? <div className="bus-tool-desc">{description}</div> : null}
      {showAlt ? <div className="bus-tool-desc-en" lang={locale === 'zh' ? 'en' : 'zh'}>{descriptionAlt}</div> : null}
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

