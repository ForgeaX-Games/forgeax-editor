import React, { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, Eye, Pencil, Save, FileCode, FileText, FileJson, File, Columns2, Paintbrush, MessageSquare } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useAppStore } from '../../store';
import { useLocalSize } from '../Resize/ResizeHandle';
import { listBusPlugins, pickLang, type BusPluginInfo } from '../../lib/bus-api';
import { iconForWorkbenchModule } from '../../lib/workbench-module-icons';
import { resolveNaming } from '../../lib/agent-name';
import { WorkbenchPluginHost, pluginRendersInMainArea } from './WorkbenchPluginHost';
import { usePanelRenderers } from '../DockShell/panelRenderers';
import { openAgentDetail } from '../../lib/open-agent-detail';
import { useFileActivityVersion, useFileLocks } from '../../lib/file-activity-stream';
import { AgentAvatarVideo } from '../AgentAvatarVideo/AgentAvatarVideo';
import { useTranslation } from '@/i18n';
import {
  foldAgents,
  type CatalogItem,
  type SkinGroup,
  type SubagentFamilyGroup,
} from '../../data/agent-groups';

type PreviewKind = 'text' | 'image' | 'audio' | 'video' | 'model' | 'binary';
interface PreviewFile {
  path: string;
  kind: PreviewKind;
  mime: string;
  bytes: number;
  content?: string;
  dirty?: boolean;
  error?: string;
}

function rawUrl(path: string): string {
  return `/api/files/raw?path=${encodeURIComponent(path)}`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// P3.19 — when no file is open in the workbench editor, show a bus-sourced
// gallery of all kind=workbench plugins instead of the 2-line `cm-mock` hint.
// Data source: `GET /api/bus/plugins?kind=workbench` (same call Sidebar P2.6a
// makes — proxied via bus-api.ts). Clicking a tile sets workbenchTab in the
// global store so the Sidebar switches to that wb-* entry and renders its
// BusPluginPlaceholder (full description + manifest path + deep-link).
// Fail-safe: fetch error → fall back to the legacy cm-mock placeholder so the
// editor area is never empty.

interface RecentEvent {
  name: string;
  path: string;
  agentId: string;
  agentName: string;
  mtime: number;
  ico?: string;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const now = Date.now();
  const delta = (now - ms) / 1000;
  if (delta < 60) return `${Math.floor(delta)}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface FileTab {
  id: string;
  name: string;
  icon: string;
  dirty?: boolean;
}

function placeholderText(t: (k: string) => string): string {
  return t('workbench.editorPlaceholder');
}

export function WorkbenchMode() {
  const workbenchTab = useAppStore((s) => s.workbenchTab);
  const expandedPluginId = useAppStore((s) => s.workbenchExpandedPluginId);
  const { workbenchPanels } = usePanelRenderers();

  if (workbenchTab === 'agents') return <AgentsMainArea />;

  if (workbenchTab === 'files') return <WorkbenchModeDefault showGalleryWhenEmpty={false} />;

  // wb:* tools tab. Standalone-iframe plugins are owned by the always-mounted
  // keep-alive CenterPluginLayer (overlay in MainArea) — render nothing here so
  // their iframe survives tab/mode switches instead of cold-restarting. A plugin
  // with an injected inline panel (host-registered, e.g. wb-plugin-author) still
  // renders here via WorkbenchPluginHost.
  if (expandedPluginId && workbenchPanels?.[expandedPluginId]) return <WorkbenchPluginHost />;
  if (expandedPluginId) return null;
  return (
    <div className="workbench-mode">
      <div className="wb-editor"><WbGallery /></div>
    </div>
  );
}

export function WorkbenchModeDefault({ showGalleryWhenEmpty = true }: { showGalleryWhenEmpty?: boolean }) {
  const { t } = useTranslation();
  const openFiles = useAppStore((s) => s.openFiles);
  const activeFilePath = useAppStore((s) => s.activeFilePath);
  const activateFile = useAppStore((s) => s.activateFile);
  const closeFile = useAppStore((s) => s.closeFile);
  const updatePreviewContent = useAppStore((s) => s.updatePreviewContent);
  const savePreviewFile = useAppStore((s) => s.savePreviewFile);
  const [bottomTab, setBottomTab] = useState<'ledger' | 'console' | 'network'>('ledger');
  const [bottomH, setBottomH] = useLocalSize('forgeax.layout.wbBottomH', 140, 80, 480);

  const activeFile = openFiles.find((f) => f.path === activeFilePath) ?? null;
  const isText = activeFile?.kind === 'text';
  const isMarkdown = isText && (activeFile?.path.endsWith('.md') ?? false);
  const [viewMode, setViewMode] = useState<'source' | 'preview'>('preview');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Reset view mode when active file changes.
  useEffect(() => {
    if (!activeFile) return;
    setViewMode(activeFile.path.endsWith('.md') ? 'preview' : 'source');
    setSaveErr(null);
  }, [activeFile?.path]);

  // Cmd/Ctrl+S to save.
  useEffect(() => {
    if (!activeFile?.dirty) return;
    const onKey = async (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        setSaving(true);
        setSaveErr(null);
        const r = await savePreviewFile();
        setSaving(false);
        if (!r.ok) setSaveErr(r.error ?? 'save failed');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeFile?.dirty, savePreviewFile]);

  const barStartYRef = useRef<number | null>(null);
  const onBarPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    barStartYRef.current = e.clientY;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };
  const onBarPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (barStartYRef.current === null) return;
    const dy = e.clientY - barStartYRef.current;
    barStartYRef.current = e.clientY;
    setBottomH((prev) => prev - dy);
  };
  const onBarFinish = (e: React.PointerEvent<HTMLDivElement>) => {
    if (barStartYRef.current === null) return;
    barStartYRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* safe to ignore */ }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveErr(null);
    const r = await savePreviewFile();
    setSaving(false);
    if (!r.ok) setSaveErr(r.error ?? 'save failed');
  };

  return (
    <div className="workbench-mode">
      <div className="wb-tabbar">
        {openFiles.map((file, i) => (
          <React.Fragment key={file.path}>
            {i > 0 && <span className="wb-tab-divider" aria-hidden />}
            <WbTabItem
              file={file}
              isActive={file.path === activeFilePath}
              onActivate={() => activateFile(file.path)}
              onClose={() => closeFile(file.path)}
            />
          </React.Fragment>
        ))}
        {activeFile && isText && (
          <div className="wb-view-controls">
            {isMarkdown && (
              <div className="wb-view-toggle">
                <button
                  className={`wb-view-btn ${viewMode === 'preview' ? 'active' : ''}`}
                  onClick={() => setViewMode('preview')}
                  title={t('workbench.previewMarkdownTitle')}
                ><Eye size={12} /> {t('workbench.preview')}</button>
                <button
                  className={`wb-view-btn ${viewMode === 'source' ? 'active' : ''}`}
                  onClick={() => setViewMode('source')}
                  title={t('workbench.sourceEditableTitle')}
                ><Pencil size={12} /> {t('workbench.source')}</button>
              </div>
            )}
            <button
              className="wb-save-btn"
              onClick={() => void handleSave()}
              disabled={!activeFile?.dirty || saving}
              title={activeFile?.dirty ? t('workbench.saveShortcutTitle') : t('workbench.noUnsavedChanges')}
            >
              <Save size={12} /> {saving ? t('workbench.saving') : t('common.save')}
            </button>
          </div>
        )}
      </div>

      <div className="wb-editor">
        {!activeFile && (showGalleryWhenEmpty
          ? <WbGallery />
          : <pre className="cm-mock thin-scrollbar"><code>{placeholderText(t)}</code></pre>
        )}
        {activeFile && <AssetView previewFile={activeFile} viewMode={viewMode} updateContent={updatePreviewContent} />}
        {saveErr && <div className="wb-save-err">{t('workbench.saveFailed')}: {saveErr}</div>}
      </div>

      <div
        className="wb-resize-bar"
        onPointerDown={onBarPointerDown}
        onPointerMove={onBarPointerMove}
        onPointerUp={onBarFinish}
        onPointerCancel={onBarFinish}
        role="separator"
        aria-orientation="horizontal"
        title={t('workbench.resizeBottomPanelTitle')}
      />
      <BottomPanel
        bottomTab={bottomTab}
        setBottomTab={setBottomTab}
        hasFile={Boolean(activeFile)}
        previewFile={activeFile}
        openFile={useAppStore((s) => s.openFile)}
        height={bottomH}
      />
    </div>
  );
}

// AssetView — kind-aware renderer. Text routes to the markdown preview or
// the editable textarea (legacy behavior); image/audio/video/model fetch
// bytes directly from /api/files/raw so the browser handles decoding. GLB
// is rendered via Google's <model-viewer> web component, lazy-imported on
// first use so the ~200KB shim/three.js bundle stays off the initial paint.
function AssetView({
  previewFile, viewMode, updateContent,
}: {
  previewFile: PreviewFile;
  viewMode: 'source' | 'preview';
  updateContent: (content: string) => void;
}) {
  const { t } = useTranslation();
  const { kind, path, mime, bytes, content, error } = previewFile;
  const isMarkdown = kind === 'text' && path.endsWith('.md');

  if (kind === 'text') {
    if (isMarkdown && viewMode === 'preview') {
      return (
        <div className="md-preview thin-scrollbar">
          <ReactMarkdown>{content ?? ''}</ReactMarkdown>
        </div>
      );
    }
    return (
      <textarea
        className="wb-source thin-scrollbar"
        value={content ?? ''}
        spellCheck={false}
        onChange={(e) => updateContent(e.target.value)}
        placeholder=""
      />
    );
  }

  if (kind === 'image') {
    return (
      <div className="wb-asset wb-asset-image">
        <img src={rawUrl(path)} alt={path} />
        <div className="wb-asset-meta">{mime} · {fmtBytes(bytes)}</div>
      </div>
    );
  }

  if (kind === 'audio') {
    return (
      <div className="wb-asset wb-asset-audio">
        <audio controls src={rawUrl(path)} preload="auto" />
        <div className="wb-asset-meta">{mime} · {fmtBytes(bytes)}</div>
      </div>
    );
  }

  if (kind === 'video') {
    return (
      <div className="wb-asset wb-asset-video">
        <video controls src={rawUrl(path)} preload="auto" />
        <div className="wb-asset-meta">{mime} · {fmtBytes(bytes)}</div>
      </div>
    );
  }

  if (kind === 'model') {
    return <ModelView path={path} mime={mime} bytes={bytes} />;
  }

  return (
    <div className="wb-asset wb-asset-binary">
      <div className="wb-asset-binary-msg">
        {error ? `${t('workbench.openFailed')}: ${error}` : t('workbench.binaryNotPreviewable')}
      </div>
      <div className="wb-asset-meta">{mime} · {fmtBytes(bytes)}</div>
      <a className="wb-asset-download" href={rawUrl(path)} download>{t('workbench.downloadOriginal')}</a>
    </div>
  );
}

function ModelView({ path, mime, bytes }: { path: string; mime: string; bytes: number }) {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Dynamic import: registers the <model-viewer> custom element globally.
    // Vite code-splits this — first .glb open pulls ~200KB; subsequent opens
    // hit cache.
    import('@google/model-viewer')
      .then(() => { if (!cancelled) setReady(true); })
      .catch((e: unknown) => { if (!cancelled) setErr((e as Error).message); });
    return () => { cancelled = true; };
  }, []);
  if (err) {
    return (
      <div className="wb-asset wb-asset-binary">
        <div className="wb-asset-binary-msg">{t('workbench.model3dLoadFailed')}: {err}</div>
        <a className="wb-asset-download" href={rawUrl(path)} download>{t('workbench.downloadOriginal')}</a>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="wb-asset wb-asset-model">
        <div className="wb-asset-binary-msg" style={{ opacity: 0.6 }}>{t('workbench.loading3dViewer')}</div>
      </div>
    );
  }
  // createElement avoids needing a global JSX intrinsic-element declaration
  // for the custom <model-viewer> tag.
  return (
    <div className="wb-asset wb-asset-model">
      {createElement('model-viewer', {
        src: rawUrl(path),
        'camera-controls': true,
        'auto-rotate': true,
        'shadow-intensity': '0.8',
        exposure: '1',
        style: { width: '100%', height: '100%', background: 'transparent' },
      })}
      <div className="wb-asset-meta">{mime} · {fmtBytes(bytes)}</div>
    </div>
  );
}

function BottomPanel({
  bottomTab, setBottomTab, hasFile, previewFile, openFile, height,
}: {
  bottomTab: 'ledger' | 'console' | 'network';
  setBottomTab: (t: 'ledger' | 'console' | 'network') => void;
  hasFile: boolean;
  previewFile: PreviewFile | null;
  openFile: (p: string) => Promise<void>;
  height: number;
}) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<RecentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const consoleLog = useAppStore((s) => s.consoleLog);
  const clearConsole = useAppStore((s) => s.clearConsole);
  const networkLog = useAppStore((s) => s.networkLog);
  const clearNetwork = useAppStore((s) => s.clearNetwork);
  const activeSid = useAppStore((s) => s.activeSid);
  // WS-driven invalidation: every file-activity:done bumps the version, which
  // re-runs the fetch effect — replaces the old 4s setInterval below for
  // sessions where the WS is connected (we keep the timer as a fail-safe for
  // the moment the socket reconnects).
  const fileActivityVersion = useFileActivityVersion(activeSid);
  const fileLocks = useFileLocks(activeSid);

  // 优先读 per-session file-activity ledger（真实归属，对齐 SSOT 原则）；活跃
  // session 不在时回退到 produces[]-derived 的 workbench 端点。两份 schema 不
  // 同：ledger 给的是 {ts, agentPath, op, path, bytes?, isCreate}，老端点是
  // {agentName, mtime, ico}。这里把 ledger 转成 RecentEvent 形态，避免下游
  // 渲染分支爆炸。
  useEffect(() => {
    let cancelled = false;
    const fetchEvents = async () => {
      try {
        if (activeSid) {
          const r = await fetch(`/api/sessions/${activeSid}/file-activity?limit=30`);
          const j = (await r.json()) as {
            records?: Array<{ ts: number; agentPath: string; op: string; path: string; bytes?: number }>;
          };
          if (!cancelled) {
            setEvents(
              (j.records ?? []).map((rec) => ({
                name: rec.path.split('/').pop() ?? rec.path,
                path: rec.path,
                agentId: rec.agentPath,
                agentName: rec.agentPath, // ledger doesn't carry display name; UI shows handle
                mtime: rec.ts,
                ico: rec.op === 'delete' ? '🗑️' : rec.op === 'rename' ? '🔀' : undefined,
              })),
            );
            setLoading(false);
            return;
          }
        }
        const r = await fetch('/api/workbench/events/recent?limit=30&lang=zh');
        const j = (await r.json()) as { events?: RecentEvent[] };
        if (!cancelled) {
          setEvents(j.events ?? []);
          setLoading(false);
        }
      } catch { if (!cancelled) setLoading(false); }
    };
    fetchEvents();
    // Long-interval safety net: WS push handles the live-update path. The
    // timer just covers reconnect gaps / initial load races — 15s is plenty.
    const t = setInterval(fetchEvents, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, [activeSid, fileActivityVersion]);

  return (
    <div className="wb-bottom" style={{ height }}>
      <div className="wb-bottom-tabs">
        {(['ledger', 'console', 'network'] as const).map((t) => {
          return (
            <button
              key={t}
              className={`wbb-tab ${bottomTab === t ? 'selected' : ''}`}
              onClick={() => setBottomTab(t)}
            >
              {t === 'ledger' && `Ledger ${events.length ? `(${events.length})` : ''}`}
              {t === 'console' && `Console${consoleLog.length ? ` ${consoleLog.length}` : ''}`}
              {t === 'network' && `Network${networkLog.length ? ` ${networkLog.length}` : ''}`}
            </button>
          );
        })}
        {bottomTab === 'console' && consoleLog.length > 0 && (
          <button className="wbb-tab" style={{ marginLeft: 'auto', color: 'var(--color-text-tertiary)' }} onClick={() => clearConsole()} title={t('workbench.clearConsole')}>
            clear
          </button>
        )}
        {bottomTab === 'network' && networkLog.length > 0 && (
          <button className="wbb-tab" style={{ marginLeft: 'auto', color: 'var(--color-text-tertiary)' }} onClick={() => clearNetwork()} title={t('workbench.clearNetwork')}>
            clear
          </button>
        )}
      </div>
      <div className="wb-bottom-body thin-scrollbar">
        {bottomTab === 'ledger' && (
          <>
            {loading && <div className="wbb-row" style={{ opacity: 0.5 }}><span>{t('common.loading')}</span></div>}
            {!loading && events.length === 0 && (
              <div className="wbb-row" style={{ opacity: 0.5 }}>
                <span>{t('workbench.ledgerEmpty')}</span>
              </div>
            )}
            {!loading && events.map((e) => {
              const lock = fileLocks.get(e.path);
              const lockTitle = lock
                ? `\n🔒 ${t('workbench.lockedBy', { agent: lock.agentPath, op: lock.op })}`
                : '';
              return (
                <button
                  key={`${e.path}-${e.mtime}`}
                  className="wbb-row event-row"
                  onClick={() => void openFile(e.path)}
                  title={`${e.path}\n${new Date(e.mtime).toLocaleString()}${lockTitle}`}
                >
                  <span className="wbb-time">{fmtTime(e.mtime)}</span>
                  <span className="wbb-tag agent">{e.agentName}</span>
                  <span className="wbb-ico">{e.ico ?? '📄'}</span>
                  <span className="wbb-name">{e.name}</span>
                  {lock && <span className="wbb-lock" aria-label={t('workbench.editing')}>🔒</span>}
                </button>
              );
            })}
          </>
        )}
        {bottomTab === 'console' && (
          <>
            {consoleLog.length === 0 && (
              <div className="wbb-row" style={{ opacity: 0.5 }}>
                <span>{t('workbench.consoleEmpty')}</span>
              </div>
            )}
            {consoleLog.map((e, i) => {
              const d = new Date(e.ts);
              const stamp = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
              return (
                <div key={i} className={`wbb-row console-row level-${e.level}`}>
                  <span className="wbb-time">{stamp}</span>
                  <span className={`wbb-tag console-${e.level}`}>{e.level}</span>
                  <span className="console-text">{e.text}</span>
                </div>
              );
            })}
          </>
        )}
        {bottomTab === 'network' && (
          <>
            {networkLog.length === 0 && (
              <div className="wbb-row" style={{ opacity: 0.5 }}>
                <span>{t('workbench.networkEmpty')}</span>
              </div>
            )}
            {networkLog.map((e, i) => {
              const d = new Date(e.ts);
              const stamp = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
              const statusLabel = e.kind === 'ws' ? (e.ok ? 'open' : 'closed') : (e.status || 'ERR');
              return (
                <div key={i} className={`wbb-row console-row level-${e.ok ? 'log' : 'error'}`} title={e.url}>
                  <span className="wbb-time">{stamp}</span>
                  <span className={`wbb-tag console-${e.ok ? 'info' : 'error'}`}>{statusLabel}</span>
                  <span className="wbb-tag tool">{e.kind === 'ws' ? 'WS' : e.method}</span>
                  <span className="console-text">{e.url}</span>
                  {e.kind !== 'ws' && <span className="wbb-time" style={{ marginLeft: 'auto' }}>{e.ms}ms</span>}
                </div>
              );
            })}
          </>
        )}
        {bottomTab === 'ledger' && hasFile && previewFile && (
          <div className="wbb-row" style={{ opacity: 0.5, marginTop: 8, borderTop: '1px solid var(--color-divider-subtle)', paddingTop: 6 }}>
            <span className="wbb-tag tool">opened</span>
            <span>{previewFile.path} · {previewFile.bytes} bytes</span>
          </div>
        )}
      </div>
    </div>
  );
}

// P3.19 — bus-sourced gallery shown when no file is open in the workbench
// editor. Replaces the legacy 2-line `cm-mock` hint with 11 clickable tiles
// (one per kind=workbench plugin). Each tile renders the shared Lucide module icon,
// displayName.zh, and a truncated description.zh; clicking deep-links into
// Sidebar's wb-* tab via store.setWorkbenchTab. fail-safe: fetch error or
// empty list → render the original cm-mock placeholder so the editor area is
// never blank.
function WbGallery() {
  const { t } = useTranslation();
  const openWorkbench = useAppStore((s) => s.openWorkbench);
  const [plugins, setPlugins] = useState<BusPluginInfo[] | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listBusPlugins('workbench')
      .then((res) => {
        if (cancelled) return;
        const visible = res.items.filter((m) => !m.workbench?.hidden);
        visible.sort((a, b) => (a.workbench?.position ?? 999) - (b.workbench?.position ?? 999));
        setPlugins(visible);
      })
      .catch(() => { if (!cancelled) setErrored(true); });
    return () => { cancelled = true; };
  }, []);

  // Fail-safe: keep legacy hint when bus is unreachable or returned no items.
  if (errored || (plugins && plugins.length === 0)) {
    return <pre className="cm-mock thin-scrollbar"><code>{placeholderText(t)}</code></pre>;
  }
  // First-paint window (< ~50ms) — render the frame so layout doesn't reflow.
  if (plugins === null) {
    return (
      <div className="wb-gallery thin-scrollbar" aria-busy="true">
        <div className="wbg-header">
          <span className="wbg-title">{t('workbench.galleryTitle')}</span>
          <span className="wbg-sub">{t('workbench.loadingPluginList')}</span>
        </div>
      </div>
    );
  }

  // P4.46 — aggregate stats across all gallery tiles. P4.43 added per-tile
  // WIP / 🛠 N / 📡 N chips; this strip rolls them up so the gallery header
  // reads as a sentence: "Σ 12 工作台 · 11 WIP · 5 🛠 · 4 📡" — same Σ-prefix
  // language as P4.45 AgentsHub header (`Σ N total · run·stop·dead`) and same
  // amber/orange/sky chip colors as the per-tile chips below for muscle memory.
  const wipCount = plugins.filter((m) => m.experimental === true).length;
  const totalTools = plugins.reduce((acc, m) => acc + (m.tools?.length ?? 0), 0);
  const totalEvents = plugins.reduce((acc, m) => acc + (m.events?.length ?? 0), 0);
  // P4.59 — bumped roll-up. Mirrors per-tile `.wbg-tile-tag.ver.bumped` from
  // A manifest version not matching /^0\.0\./ counts as "bumped" — moved
  // past placeholder semver. Surfaces as a 5th roll-up beside Σ/WIP/🛠/📡,
  // colored lavender to match the per-tile chip.
  const bumpedCount = plugins.filter((m) => !/^0\.0\./.test(m.version ?? '0.0.0')).length;
  const statsTitle =
    `Σ ${plugins.length} workbench plugin · ` +
    `${wipCount} experimental(WIP) · ` +
    `${totalTools} tool(s) on bus · ` +
    `${totalEvents} event(s) emitted · ` +
    `${bumpedCount} ${t('workbench.bumpedStatsSuffix')}`;
  const statsAria =
    `${plugins.length} workbench plugins total — ` +
    `${wipCount} experimental, ${totalTools} tools, ${totalEvents} events, ${bumpedCount} bumped`;
  return (
    <div className="wb-gallery thin-scrollbar">
      <div className="wbg-header">
        <span className="wbg-title">{t('workbench.galleryTitle')}</span>
        <span className="wbg-count">· {plugins.length} plugins</span>
        <span className="wbg-stats" title={statsTitle} aria-label={statsAria} role="group">
          <span className="wbg-stats-pill wbg-stats-total">
            <span className="wbg-stats-sigma" aria-hidden>Σ</span>
            <span className="wbg-stats-n">{plugins.length}</span>
          </span>
          <span className="wbg-stats-vsep" aria-hidden />
          {wipCount > 0 && (
            <span className="wbg-stats-pill wbg-stats-wip" title={`${wipCount} experimental placeholder(s)`}>
              WIP <span className="wbg-stats-n">{wipCount}</span>
            </span>
          )}
          {totalTools > 0 && (
            <span className="wbg-stats-pill wbg-stats-tools" title={`${totalTools} tool(s) on bus across all workbench plugins`}>
              🛠 <span className="wbg-stats-n">{totalTools}</span>
            </span>
          )}
          {totalEvents > 0 && (
            <span className="wbg-stats-pill wbg-stats-events" title={`${totalEvents} event(s) emitted across all workbench plugins`}>
              📡 <span className="wbg-stats-n">{totalEvents}</span>
            </span>
          )}
          {bumpedCount > 0 && (
            <span
              className="wbg-stats-pill wbg-stats-bumped"
              title={`${bumpedCount} workbench plugin${bumpedCount === 1 ? '' : 's'} bumped past 0.0.x · ${t('workbench.implementedEntryCount')}`}
              aria-label={`${bumpedCount} bumped`}
            >
              <span aria-hidden>v</span>
              <span className="wbg-stats-n">{bumpedCount}</span>
            </span>
          )}
        </span>
        <span className="wbg-sub">{t('workbench.gallerySub')}</span>
      </div>
      <div className="wbg-grid">
        {plugins.map((m, i) => {
          const rank = i + 1;
          const wbId = m.workbench?.id ?? m.id.replace(/^@forgeax-plugin\//, '');
          const name = pickLang(m.displayName, 'zh', wbId);
          const desc = pickLang(m.description, 'zh', '');
          const Icon = iconForWorkbenchModule({
            workbenchId: wbId,
            label: name,
            pluginId: m.id,
          });
          const sizeTag = m.workbench?.panelSize ?? 'md';
          // Surface bus capability counts on each tile so the gallery
          // visually distinguishes "real" workbench plugins from pure
          // placeholders. experimental:true → amber WIP chip; tools.length →
          // orange 🛠 N; events.length → sky 📡 N.
          const toolCount = m.tools?.length ?? 0;
          const eventCount = m.events?.length ?? 0;
          const isWip = m.experimental === true;
          // Surface manifest `version` as a tiny chip so manifest bumps
          // become visible in the gallery — gives a second "real vs
          // placeholder" axis beyond the existing WIP/🛠/📡 chips.
          const ver = m.version ?? '0.0.0';
          const verBumped = !/^0\.0\./.test(ver);
          const titleParts = [`#${rank} · ${name}`, m.id, `v${ver}`];
          if (isWip) titleParts.push('experimental placeholder');
          if (toolCount > 0) titleParts.push(`${toolCount} tool${toolCount === 1 ? '' : 's'}`);
          if (eventCount > 0) titleParts.push(`${eventCount} event${eventCount === 1 ? '' : 's'}`);
          return (
            <button
              key={m.id}
              className={`wbg-tile size-${sizeTag}${verBumped ? ' bumped' : ''}`}
              onClick={() => {
                // Atomic open — split-surface plugins (Module 16) expand into
                // the center AND flip the sidebar tab in one go; single-pane
                // plugins just flip the tab (expandedPluginId null). One action
                // = no tab/center desync (architecture review §B3).
                openWorkbench({ tab: `wb:${wbId}`, expandedPluginId: pluginRendersInMainArea(m) ? m.id : null });
              }}
              title={titleParts.join(' · ')}
              aria-label={`#${rank} ${name}${verBumped ? ' · bumped' : ''}`}
            >
              <span
                className="wbg-tile-rank"
                title={`#${rank} of ${plugins.length} · ${t('workbench.positionDecidesOrder')}`}
                aria-hidden
              >#{rank}</span>
              <span className="wbg-tile-ico" aria-hidden>
                <Icon size={22} strokeWidth={1.8} />
                {verBumped && (
                  <sup
                    className="wbg-tile-ico-ver"
                    title={`manifest v${ver} bumped · ${t('workbench.bumpedPastPlaceholder')}`}
                    aria-hidden
                  >v</sup>
                )}
              </span>
              <span className="wbg-tile-name">{name}</span>
              {desc && <span className="wbg-tile-desc">{desc}</span>}
              <span className="wbg-tile-meta">
                <span className="wbg-tile-tag">wb-{wbId}</span>
                <span className="wbg-tile-tag size">{sizeTag}</span>
                <span
                  className={`wbg-tile-tag ver${verBumped ? ' bumped' : ''}`}
                  title={
                    verBumped
                      ? `manifest version ${ver} · ${t('workbench.verTagBumped')}`
                      : `manifest version ${ver} · ${t('workbench.verTagPlaceholder')}`
                  }
                  aria-label={`version ${ver}`}
                >v{ver}</span>
                {isWip && (
                  <span className="wbg-tile-tag wip" title={t('workbench.wipTagTitle')}>
                    WIP
                  </span>
                )}
                {toolCount > 0 && (
                  <span className="wbg-tile-tag tools" title={`${toolCount} tool${toolCount === 1 ? '' : 's'} on bus · ${t('workbench.toolsExposedToAi')}`}>
                    🛠 {toolCount}
                  </span>
                )}
                {eventCount > 0 && (
                  <span className="wbg-tile-tag events" title={`${eventCount} event${eventCount === 1 ? '' : 's'} emitted by this workbench plugin`}>
                    📡 {eventCount}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// AgentsMainArea — full-width agents workspace shown in MainArea when
// workbenchTab === 'agents'. Fetches the same /api/workbench/agents data as
// AgentsPanel but renders it in a 2-column card grid with per-agent file
// lists. Clicking a file opens it in the editor (switches to 'files' tab).
//
// ADR-0019 §9 — Catalog-side fold (2026-06-22):
// Server returns a flat list of ~28 agents but contains 3 latent relationships
// (skin family / sub-agent family / provider-default coders). We use
// `foldAgents()` from `data/agent-groups.ts` to collapse them visually:
//   - skin group → one card with a chip row of skin variants
//   - subagent-family → lead card + nested mini-card column for sub-agents
//   - everything else → flat card (unchanged behavior)
//
// Click semantics (per user decision 2026-06-22 "view_only_strict"):
//   - flat agent  → openAgentDetail(id)              [unchanged: opens editor + setTabAgent]
//   - skin chip   → openAgentDetail(skinId)          [picking a skin IS the routing intent]
//   - lead card   → openAgentDetail(leadId)          [normal: addressing lead is fine]
//   - sub-card    → openAgentDetail(subId, switchChat: false)
//                   [view-only: catalog browsing must NOT auto-route the chat to a sub;
//                    conversation goes through lead → delegate_to_subagent]
//
// Surfaces deliberately kept flat (per ADR-0019 §9):
//   - Sidebar/AgentsPanel (runtime instances), SettingsPanel/SectionsRegister
//     (per-agent install/uninstall), Composer @-mention dropdown, ChatAgentCapsule.
interface AgentRec {
  id: string;
  name: string;
  personName?: string;
  naming?: { title: string; sub: string };
  role: string;
  color: string;
  avatar: string;
  status: 'active' | 'placeholder';
  isMain: boolean;
  files: Array<{ name: string; path: string; ico: string }>;
}

export function AgentsMainArea() {
  const { t } = useTranslation();
  const openFile = useAppStore((s) => s.openFile);
  const openWorkbench = useAppStore((s) => s.openWorkbench);
  const activeSid = useAppStore((s) => s.activeSid);
  // Drives skin-group active highlighting: which member of the skin family is
  // currently bound to the chat tab. We read `tab.agentId` (runtime truth)
  // instead of `agentBySid` (persistence cache) so the chip lit-state stays
  // in sync with every code path that touches the active agent — including
  // chat-side switches that update tab.agentId without going through the
  // setTabAgent action (e.g. mid-stream agent self-handoff). This mirrors
  // what ChatAgentCapsule reads.
  const activeAgentId = useAppStore(
    (s) => s.tabs.find((t) => t.sid === s.activeSid)?.agentId ?? null,
  );
  // Agents the user opted OUT of (Settings → Agents checkboxes). They're
  // excluded from the main avatar row / delegate tools, so reflect that here
  // too: dim the card + drop the "active" badge instead of misleadingly
  // showing every loaded agent as active.
  const uninstalledAgentIds = useAppStore((s) => s.uninstalledAgentIds);
  const [agents, setAgents] = useState<AgentRec[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Mirrors `agents` for use inside the polling closure (which only re-binds on
  // activeSid change, so reading `agents` directly there would be stale).
  const agentsRef = useRef<AgentRec[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    // include=files: AgentsMainArea renders the per-agent files grid. Passing
    // &sid lets the server resolve products from the session's file-activity
    // ledger (actual writes) instead of the produces[] glob (intent) — without
    // it, an agent that already wrote files shows "暂无产物文件". A 5s poll
    // keeps the grid live as agents produce and self-heals transient failures
    // (the old one-shot fetch only recovered on a tab-switch remount).
    const load = async () => {
      try {
        const qs = activeSid
          ? `?include=files&sid=${encodeURIComponent(activeSid)}`
          : '?include=files';
        const r = await fetch(`/api/workbench/agents${qs}`);
        if (cancelled) return;
        if (!r.ok) throw new Error(`${r.status}`);
        const j = (await r.json()) as { agents?: AgentRec[] };
        if (cancelled) return;
        agentsRef.current = j.agents ?? [];
        setAgents(j.agents ?? []);
        setErr(null);
      } catch (e: unknown) {
        if (cancelled) return;
        // Only surface the error if we have nothing to show yet; otherwise keep
        // the last good grid and retry silently on the next tick.
        if (agentsRef.current === null) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    timer = setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [activeSid]);

  const handleFileClick = (path: string) => {
    openWorkbench({ tab: 'files', expandedPluginId: null });
    void openFile(path);
  };

  // ── Masonry via JS-distributed flex columns (replaces CSS `columns` multicol) ──
  // Why not CSS multicol anymore: WebKit (WKWebView/.app) mispaints the
  // composited <video> avatars inside a multicol fragmentation context — on
  // hover repaint a card's video gets drawn at a wrong page coordinate
  // (duplicate avatar near the window bottom / black flash). CSS multicol was
  // the trigger; no in-flow/clip/compositing tweak fixed it while the cards
  // lived in a fragmented column flow. We keep the masonry *look* (balanced
  // columns, no row-height gaps) by measuring the container width and splitting
  // the folded items into N plain flex columns ourselves — a non-fragmented
  // layout WebKit composites correctly.
  const COL_TARGET = 280; // px, mirrors the old `columns: 280px`
  const COL_GAP = 12;
  const [colCount, setColCount] = useState(1);
  const roRef = useRef<ResizeObserver | null>(null);
  const gridRefCb = useCallback((node: HTMLDivElement | null) => {
    if (roRef.current) {
      roRef.current.disconnect();
      roRef.current = null;
    }
    if (!node) return;
    const recompute = () => {
      const w = node.clientWidth;
      const n = Math.max(1, Math.floor((w + COL_GAP) / (COL_TARGET + COL_GAP)));
      setColCount((prev) => (prev === n ? prev : n));
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(node);
    roRef.current = ro;
  }, []);

  if (err) {
    return (
      <div className="wm-agents-main">
        <div className="wm-agents-err">{t('workbench.agentsLoadFailed')}: {err}</div>
      </div>
    );
  }

  if (agents === null) {
    return (
      <div className="wm-agents-main">
        <div className="wm-agents-loading">{t('common.loading')}</div>
      </div>
    );
  }

  return (
    <div className="wm-agents-main thin-scrollbar">
      <div className="wm-agents-header">
        <span className="wm-agents-title">{t('workbench.agentsTitle')}</span>
        <span className="wm-agents-count">{agents.length} agents</span>
      </div>
      {agents.length === 0 ? (
        <div className="wm-agents-empty">
          <span>{t('workbench.agentsEmpty')}</span>
        </div>
      ) : (
        (() => {
          const renderItem = (
            item: CatalogItem<AgentRec>,
          ): { key: string; node: ReactNode } => {
            if (item.kind === 'flat') {
              return {
                key: item.agent.id,
                node: (
                  <AgentCard
                    a={item.agent}
                    variant="flat"
                    uninstalledAgentIds={uninstalledAgentIds}
                    handleFileClick={handleFileClick}
                    t={t}
                  />
                ),
              };
            }
            if (item.kind === 'subagent-family') {
              return {
                key: item.group.id,
                node: (
                  <SubagentFamilyGroupCard
                    group={item.group}
                    lead={item.lead}
                    subs={item.subs}
                    uninstalledAgentIds={uninstalledAgentIds}
                    handleFileClick={handleFileClick}
                    t={t}
                  />
                ),
              };
            }
            // skin-group
            return {
              key: item.group.id,
              node: (
                <SkinGroupCard
                  group={item.group}
                  members={item.members}
                  providers={item.providers}
                  head={item.head}
                  activeAgentId={activeAgentId}
                  uninstalledAgentIds={uninstalledAgentIds}
                  handleFileClick={handleFileClick}
                  t={t}
                />
              ),
            };
          };
          // Round-robin distribute folded items into colCount columns. Keeps a
          // natural row-major reading order (item 0,1,2 across the top row) and
          // spreads the few tall group cards (iro/reia/skin) across columns for
          // rough height balance — good enough without measuring card heights.
          const items = foldAgents(agents, { activeId: activeAgentId });
          const columns: Array<Array<{ key: string; node: ReactNode }>> =
            Array.from({ length: colCount }, () => []);
          items.forEach((item, i) => {
            columns[i % colCount].push(renderItem(item));
          });
          return (
            <div className="wm-agents-grid" ref={gridRefCb}>
              {columns.map((col, ci) => (
                <div className="wm-agents-col" key={ci}>
                  {col.map((c) => (
                    <React.Fragment key={c.key}>{c.node}</React.Fragment>
                  ))}
                </div>
              ))}
            </div>
          );
        })()
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Per-card subcomponents for AgentsMainArea grid.
//
// Why subcomponents instead of inline JSX:
//   - 3 different visual treatments (flat / skin-group / subagent-family) each
//     ~30 lines of JSX. Inlining all 3 inside the .map() makes AgentsMainArea
//     unreadable.
//   - Sub-cards inside subagent-family share most of their layout with the
//     standalone flat card (avatar + meta + badge + files) — `AgentCard` is
//     reused there in `variant="sub"` mode (compact, no file list, view-only).
// ───────────────────────────────────────────────────────────────────────────

type AgentCardVariant = 'flat' | 'lead' | 'sub' | 'provider';

type TFn = (key: string) => string;

function AgentCard({
  a,
  variant,
  uninstalledAgentIds,
  handleFileClick,
  derivedStatus,
  t,
}: {
  a: AgentRec;
  variant: AgentCardVariant;
  uninstalledAgentIds: string[];
  handleFileClick: (path: string) => void;
  /**
   * Optional badge override. The flat / sub variants display badge based on
   * `a.status` directly. For LEAD cards we aggregate sub status into the
   * lead so a placeholder lead with running subs reads as `active` — without
   * this, the right-side badge area on iro / reia would always be empty
   * because the lead itself isn't spawned (Forge dispatches subs through
   * delegate_to_subagent, never the lead's chat instance).
   */
  derivedStatus?: AgentRec['status'];
  t: TFn;
}) {
  const off = !a.isMain && uninstalledAgentIds.includes(a.id);
  // Click semantics by variant:
  //   'sub'      → view-only (no setTabAgent) — caller is browsing subs of a
  //                lead family; chat must continue through the lead per
  //                view_only_strict decision (2026-06-22).
  //   'provider' → full openAgentDetail — provider-default coders are
  //                independent chat targets; clicking commits to that driver.
  //   'flat'/'lead' → full openAgentDetail (default).
  const isSub = variant === 'sub';
  const isProvider = variant === 'provider';
  // sub + provider share the compact mini-card visual (no file list, smaller
  // avatar). Only their click handlers differ.
  const isCompact = isSub || isProvider;
  const handleClick = () => openAgentDetail(a.id, isSub ? { switchChat: false } : undefined);
  const avatarSize = isCompact ? 36 : 48;
  // Status used for both the placeholder class and the right-side badge.
  const effectiveStatus: AgentRec['status'] = derivedStatus ?? a.status;
  const cls = [
    'wm-agent-card',
    'is-clickable',
    a.isMain ? 'main' : '',
    effectiveStatus === 'placeholder' || off ? 'placeholder' : '',
    variant === 'lead' ? 'is-lead' : '',
    isCompact ? 'wm-agent-sub-mini' : '',
  ].filter(Boolean).join(' ');
  return (
    <div
      role="button"
      tabIndex={0}
      className={cls}
      data-agent-id={a.id}
      data-agent-name={a.name}
      onClick={handleClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); } }}
      title={off
        ? `${a.name} · ${a.role} · ${t('workbench.agentDisabledTitle')}`
        : `${a.name} · ${a.role} · ${t('workbench.agentDetailTitle')}`}
    >
      <div className="wm-agent-card-header">
        {/* ADR-0019: workbench/tools 列表 - mode='idle' 循环 default (期待).
         *  size=48 跟 .wm-agent-avatar 对齐 (CSS 已从 32→48). Sub-mini 用 36
         *  以匹配缩进后的视觉权重. */}
        <AgentAvatarVideo
          agentId={a.id}
          mode="idle"
          size={avatarSize}
          shape="circle"
          fallback={
            <span
              className="wm-agent-avatar"
              style={{
                background: a.color,
                width: avatarSize,
                height: avatarSize,
                fontSize: isSub ? 14 : 18,
              }}
            >
              {a.avatar}
            </span>
          }
        />
        <div className="wm-agent-meta">
          <span className="wm-agent-name">{resolveNaming(a).title}</span>
          <span className="wm-agent-role">{resolveNaming(a).sub || a.role}</span>
        </div>
        {off
          ? <span className="wm-agent-badge">{t('workbench.disabledBadge')}</span>
          : effectiveStatus === 'active' && <span className="wm-agent-badge active">active</span>}
      </div>
      {/* Sub & provider mini-cards skip the file list to keep the nested column compact. */}
      {!isCompact && a.files.length > 0 && (
        <ul className="wm-agent-files">
          {a.files.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                className="wm-agent-file-btn"
                onClick={(e) => { e.stopPropagation(); handleFileClick(f.path); }}
                title={f.path}
              >
                <span className="wm-agent-file-ico" aria-hidden>{f.ico}</span>
                <span className="wm-agent-file-name">{f.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!isCompact && a.files.length === 0 && (
        <div className="wm-agent-no-files">{t('workbench.noProducedFiles')}</div>
      )}
    </div>
  );
}

function SubagentFamilyGroupCard({
  group,
  lead,
  subs,
  uninstalledAgentIds,
  handleFileClick,
  t,
}: {
  group: SubagentFamilyGroup;
  lead: AgentRec;
  subs: AgentRec[];
  uninstalledAgentIds: string[];
  handleFileClick: (path: string) => void;
  t: TFn;
}) {
  void group;
  // Aggregate the family's runtime state into the lead card's badge slot.
  // Rationale: the lead is rarely "active" on its own — Forge dispatches via
  // delegate_to_subagent into the subs, so /api/workbench/agents reports
  // lead.status='placeholder' while subs.status='active'. Without this
  // aggregation, iro / reia would always read as "idle" even when their
  // family is busy doing work. We promote sub activity to the lead card so
  // the catalog reflects "this family is in use".
  const anySubActive = subs.some((s) => s.status === 'active');
  const leadDerivedStatus: AgentRec['status'] =
    lead.status === 'active' || anySubActive ? 'active' : lead.status;
  return (
    <div className="wm-agent-group-subagent">
      <AgentCard
        a={lead}
        variant="lead"
        uninstalledAgentIds={uninstalledAgentIds}
        handleFileClick={handleFileClick}
        derivedStatus={leadDerivedStatus}
        t={t}
      />
      {/* Hint row that visually frames the nested column as "subordinates of
       *  the lead above". Mirrors `.nested { border-left: dashed }` from the
       *  v2-vision mockup. */}
      <div className="wm-agent-nested-hint">
        ↳ {t('workbench.subagentsHint').replace('{n}', String(subs.length))}
      </div>
      <div className="wm-agent-nested">
        {subs.map((sub) => (
          <AgentCard
            key={sub.id}
            a={sub}
            variant="sub"
            uninstalledAgentIds={uninstalledAgentIds}
            handleFileClick={handleFileClick}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

function SkinGroupCard({
  group,
  members,
  providers,
  head,
  activeAgentId,
  uninstalledAgentIds,
  handleFileClick,
  t,
}: {
  group: SkinGroup;
  members: AgentRec[];
  providers: AgentRec[];
  head: AgentRec;
  activeAgentId: string | null;
  uninstalledAgentIds: string[];
  handleFileClick: (path: string) => void;
  t: TFn;
}) {
  // Aggregate state of the WHOLE coder family — both skin members and
  // provider-default coders — into the head badge. Mirrors the
  // SubagentFamilyGroupCard "active if any member is active" rule. Without
  // this, the right-side badge slot on 程序员 would always be empty even
  // when coders are spawned, because there's no single "lead" entity to
  // report status from.
  //
  //   anyActive → show green "active"
  //   all off   → show "已停用"
  //   otherwise → no badge (placeholder / idle state)
  const family = [...members, ...providers];
  const anyActive = family.some((m) => m.status === 'active');
  const allOff = family.every((m) => !m.isMain && uninstalledAgentIds.includes(m.id));
  // Structural shape mirrors SubagentFamilyGroupCard (no outer frame on the
  // group wrapper) so the visual reads the same as iro / reia: the lead
  // card has its own frame, the dashed nested column hangs below it, and
  // each provider mini-card is its own framed card. Earlier version wrapped
  // the whole group in a single big bordered card which made head + chips +
  // providers all look like one giant card — fixed 2026-06-22.
  return (
    <div className="wm-agent-group-subagent">
      <div className="wm-agent-card wm-agent-skin-head-card">
        <div className="wm-agent-card-header">
          {/* Head visual follows the active skin (so the card identity reflects
           *  the current chat). Falls back to representativeId via foldAgents. */}
          <AgentAvatarVideo
            agentId={head.id}
            mode="idle"
            size={48}
            shape="circle"
            fallback={
              <span className="wm-agent-avatar" style={{ background: head.color }}>{head.avatar}</span>
            }
          />
          <div className="wm-agent-meta">
            <span className="wm-agent-name">{group.label} · {head.name}</span>
            <span className="wm-agent-role">{group.sublabel}</span>
          </div>
          {allOff
            ? <span className="wm-agent-badge">{t('workbench.disabledBadge')}</span>
            : anyActive && <span className="wm-agent-badge active">active</span>}
        </div>
        <div className="wm-skin-chip-row">
          {members.map((m) => (
            <SkinChip
              key={m.id}
              m={m}
              isActive={m.id === activeAgentId}
              uninstalledAgentIds={uninstalledAgentIds}
            />
          ))}
        </div>
        <div className="wm-agent-no-files">{t('workbench.skinGroupHint')}</div>
      </div>
      {providers.length > 0 && (
        <>
          <div className="wm-agent-nested-hint">
            ↳ {t('workbench.providerCodersHint').replace('{n}', String(providers.length))}
          </div>
          <div className="wm-agent-nested">
            {providers.map((p) => (
              <AgentCard
                key={p.id}
                a={p}
                variant="provider"
                uninstalledAgentIds={uninstalledAgentIds}
                handleFileClick={handleFileClick}
                t={t}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Skin chip with two-tier click semantics (2026-06-22 follow-up):
//   - single-click: setTabAgent ONLY — switch the chat to this persona,
//                   do not open the persona editor iframe. Fires
//                   synchronously so the chip lights up instantly.
//   - double-click: full openAgentDetail — opens persona editor (which
//                   also calls setTabAgent internally, harmless because
//                   it's idempotent — the chip is already on this skin
//                   after the single-click that precedes the second click).
//
// Implementation note: a previous version debounced single-click by 250ms
// to "cancel" it on dblclick. That left users staring at an un-updated
// chip for a quarter second after every click (and in practice the timer
// occasionally didn't fire at all, leaving the chip stuck — see chat log
// 2026-06-22). The simpler design is: fire both handlers; setTabAgent is
// cheap and idempotent, openAgentDetail's only extra side effect is
// opening the persona iframe (which is exactly the dblclick intent).
function SkinChip({
  m,
  isActive,
  uninstalledAgentIds,
}: {
  m: AgentRec;
  isActive: boolean;
  uninstalledAgentIds: string[];
}) {
  const off = !m.isMain && uninstalledAgentIds.includes(m.id);
  const setTabAgent = useAppStore((s) => s.setTabAgent);
  const activeSid = useAppStore((s) => s.activeSid);
  const handleClick = () => {
    if (activeSid) setTabAgent(activeSid, m.id);
  };
  const handleDoubleClick = () => {
    openAgentDetail(m.id);
  };
  return (
    <button
      type="button"
      className={`wm-skin-chip${isActive ? ' active' : ''}${off ? ' placeholder' : ''}`}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      title={`${m.name} · ${m.role} · 单击切换 · 双击进 Persona 编辑`}
      data-agent-id={m.id}
    >
      <AgentAvatarVideo
        agentId={m.id}
        mode="idle"
        size={26}
        shape="circle"
        fallback={
          <span
            className="wm-agent-avatar"
            style={{ background: m.color, width: 26, height: 26, fontSize: 12 }}
          >
            {m.avatar}
          </span>
        }
      />
      <span className="wm-skin-chip-name">{m.name}</span>
    </button>
  );
}

function WbTabItem({
  file,
  isActive,
  onActivate,
  onClose,
}: {
  file: PreviewFile;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const name = file.path.split('/').pop() ?? file.path;
  const [tipPos, setTipPos] = useState<{ x: number; y: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabRef = useRef<HTMLDivElement>(null);

  const clearTimer = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  };

  const handleMouseEnter = () => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      const el = tabRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setTipPos({ x: rect.left, y: rect.bottom + 4 });
    }, 600);
  };

  const handleMouseLeave = () => {
    clearTimer();
    setTipPos(null);
  };

  useEffect(() => () => clearTimer(), []);

  return (
    <>
      <div
        ref={tabRef}
        className={`wb-tab${isActive ? ' active' : ''}${file.dirty ? ' dirty' : ''}`}
        onClick={onActivate}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <span className="wb-tab-ico">{iconFor(file.path)}</span>
        <span className="wb-tab-name">{name}{/* file.dirty ? ' •' : '' — TODO: dirty indicator */}</span>
        <span className="wb-tab-close" onClick={(e) => { e.stopPropagation(); onClose(); }}>
          <X size={12} />
        </span>
      </div>
      {tipPos && createPortal(
        <div className="wb-tab-tooltip" style={{ left: tipPos.x, top: tipPos.y }} role="tooltip">
          {file.path}
        </div>,
        document.body,
      )}
    </>
  );
}

function iconFor(path: string): React.ReactNode {
  const name = path.toLowerCase();
  if (name.endsWith('.ts') || name.endsWith('.tsx')) return <FileCode size={12} />;
  if (name.includes('pillar')) return <Columns2 size={12} />;
  if (name.includes('design')) return <Paintbrush size={12} />;
  if (name.includes('narrative') || name.includes('dialog')) return <MessageSquare size={12} />;
  if (name.endsWith('.json')) return <FileJson size={12} />;
  if (name.endsWith('.md')) return <FileText size={12} />;
  return <File size={12} />;
}
