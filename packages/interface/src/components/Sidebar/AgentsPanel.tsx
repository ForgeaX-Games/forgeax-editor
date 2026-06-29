import { useState, useRef, useEffect, type ReactNode, type KeyboardEvent, type CSSProperties } from 'react';
import { FileCode2, FileJson, FileText, FileImage, FileAudio, File as FileIcon } from 'lucide-react';
import { useAppStore, type LiveAgent, type AgentFileTouch } from '../../store';
import { openAgentDetail } from '../../lib/open-agent-detail';
import { AgentAvatarVideo } from '../AgentAvatarVideo/AgentAvatarVideo';
import { useTranslation } from '@/i18n';

function FileGlyph({ name }: { name: string }): ReactNode {
  const n = name.toLowerCase();
  if (n.endsWith('.json')) return <FileJson size={11} />;
  if (n.endsWith('.md')) return <FileText size={11} />;
  if (['.ts', '.tsx', '.js'].some((e) => n.endsWith(e))) return <FileCode2 size={11} />;
  if (['.png', '.jpg', '.webp', '.svg'].some((e) => n.endsWith(e))) return <FileImage size={11} />;
  if (['.mp3', '.wav', '.ogg'].some((e) => n.endsWith(e))) return <FileAudio size={11} />;
  return <FileIcon size={11} />;
}

const GRADIENTS = [
  'linear-gradient(135deg, var(--primary), var(--accent-cyan))',
  'linear-gradient(135deg, var(--accent-orange), var(--accent-pink))',
  'linear-gradient(135deg, var(--accent-purple), var(--accent-cyan))',
  'linear-gradient(135deg, var(--accent-cyan), var(--accent-green))',
  'linear-gradient(135deg, var(--color-status-amber), var(--accent-orange))',
  'linear-gradient(135deg, var(--accent-error), var(--accent-pink))',
];
function gradFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return GRADIENTS[Math.abs(h) % GRADIENTS.length]!;
}
function initialFor(id: string): string {
  const parts = id.split(/[-_]/);
  if (parts.length >= 2 && parts[0] && parts[1]) return (parts[0][0]! + parts[1][0]!).toUpperCase();
  return id.slice(0, 2).toUpperCase();
}

// Stable empty fallbacks. zustand v5 (useSyncExternalStore) requires selectors
// to return a cached reference; returning a fresh `[]`/`{}` literal each call
// triggers "getSnapshot should be cached" → infinite re-render loop.
const EMPTY_AGENTS: LiveAgent[] = [];
const EMPTY_FILE_ACTIVITY: Record<string, AgentFileTouch[]> = {};
const EMPTY_STREAMING: Record<string, boolean> = {};

function dedupeFiles(touches: AgentFileTouch[]): AgentFileTouch[] {
  const byPath = new Map<string, AgentFileTouch>();
  for (const t of touches) {
    const existing = byPath.get(t.path);
    if (!existing || t.ts > existing.ts) byPath.set(t.path, t);
  }
  return Array.from(byPath.values());
}

export function AgentsPanel(): ReactNode {
  const { t } = useTranslation();
  const activeSid = useAppStore((s) => s.activeSid);
  const liveAgents = useAppStore((s) => s.liveAgents[s.activeSid ?? ''] ?? EMPTY_AGENTS);
  const fileActivity = useAppStore((s) => s.agentFileActivity[s.activeSid ?? ''] ?? EMPTY_FILE_ACTIVITY);
  const streamingByAgent = useAppStore(
    (s) => s.tabs.find((t) => t.sid === s.activeSid)?.streamingByAgent ?? EMPTY_STREAMING,
  );
  const [highlight, setHighlight] = useState<string>('');
  // Distinguishes "haven't gotten a successful list_agents yet" (→ 加载中) from
  // "fetched and the session genuinely has no agents yet" (→ empty hint). Reset
  // whenever the active session changes. Without this, a session that boots
  // with an empty roster (root not scaffolded yet) sat on 加载中... forever.
  const [loaded, setLoaded] = useState(false);
  const rowButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const openFile = useAppStore((s) => s.openFile);

  // Self-contained list_agents poll. `liveAgents` was previously fed ONLY by
  // AgentSwitcher (chat panel), whose poll is gated by an IntersectionObserver
  // — so whenever the chat panel is collapsed/hidden (e.g. Preview/Workbench
  // mode) this left panel never received data and sat on "加载中..." forever.
  // This poll mirrors only the setLiveAgents data sync (NOT AgentSwitcher's
  // tab-agent pin logic), is idempotent with it, and pauses when the tab is
  // hidden to avoid background churn.
  useEffect(() => {
    if (!activeSid) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    setLoaded(false);
    const poll = async () => {
      try {
        const { listSessionAgents } = await import('../../lib/forgeax-bridge');
        const items = await listSessionAgents(activeSid);
        if (cancelled) return;
        // A successful response — even an empty one — means we're past the
        // initial-load phase. Flip `loaded` so the UI can show an empty hint
        // instead of a perpetual spinner.
        setLoaded(true);
        // Don't blank an already-populated panel on a transient empty result;
        // only write through when there's something to show.
        if (items.length === 0) return;
        useAppStore.getState().setLiveAgents(
          activeSid,
          items.map((a) => ({
            path: a.path,
            display: a.display,
            parent: a.parent,
            running: a.running,
            depth: a.depth,
          })),
        );
      } catch {
        /* keep last known list; transient command/WS hiccups shouldn't blank the panel */
      }
    };
    const start = () => {
      if (timer) return;
      void poll();
      timer = setInterval(() => void poll(), 5000);
    };
    const stop = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };
    const onVis = () => (document.hidden ? stop() : start());
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [activeSid]);

  // Seed per-agent file activity from the session's file-activity ledger once
  // per session. agentFileActivity is otherwise fed ONLY by the live tool
  // stream (pushFileTouch in session-stream), so on a fresh load / tab switch
  // this panel showed no files for work the agent already did before this
  // client connected. The ledger is the SSOT of real writes; dedupeFiles()
  // collapses any overlap with subsequent live touches by path.
  useEffect(() => {
    if (!activeSid) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/sessions/${activeSid}/file-activity?limit=100`);
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as {
          records?: Array<{ ts: number; agentPath: string; op: string; path: string }>;
        };
        if (cancelled) return;
        const push = useAppStore.getState().pushFileTouch;
        for (const rec of j.records ?? []) {
          if (!rec.agentPath || !rec.path) continue;
          push(activeSid, rec.agentPath, {
            callId: `ledger:${rec.path}:${rec.ts}`,
            path: rec.path,
            name: rec.path.split('/').pop() ?? rec.path,
            op: rec.op,
            ts: rec.ts,
            status: 'done',
          });
        }
      } catch {
        /* ledger seed is best-effort; live stream still populates going forward */
      }
    })();
    return () => { cancelled = true; };
  }, [activeSid]);

  if (!activeSid) {
    return <div className="agents-panel"><div className="ac-empty">{t('agentsPanel.noActiveSession')}</div></div>;
  }

  if (liveAgents.length === 0) {
    return (
      <div className="agents-panel">
        <div className="ac-empty">{loaded ? t('agentsPanel.empty') : t('common.loading')}</div>
      </div>
    );
  }

  const sorted = [...liveAgents].sort((a, b) => {
    if (a.parent === null && b.parent !== null) return -1;
    if (a.parent !== null && b.parent === null) return 1;
    return 0;
  });

  const flatRowIds = sorted.map((a) => a.path);
  const tabbableId = flatRowIds.includes(highlight) ? highlight : (flatRowIds[0] ?? '');
  const onRowKey = (e: KeyboardEvent<HTMLButtonElement>, currentId: string) => {
    if (e.target !== e.currentTarget) return;
    const idx = flatRowIds.indexOf(currentId);
    if (idx < 0) return;
    let next = -1;
    const len = flatRowIds.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (idx + 1) % len;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (idx - 1 + len) % len;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = len - 1;
    else return;
    e.preventDefault();
    const targetId = flatRowIds[next];
    if (!targetId) return;
    setHighlight(targetId);
    const btn = rowButtonRefs.current.get(targetId);
    if (btn) btn.focus();
  };

  return (
    <div className="agents-panel rail-panel" role="listbox" aria-label="Sidebar agents" aria-orientation="vertical">
      <div className="ap-header">
        <span className="ap-h-label">AGENTS</span>
        <span className="ap-h-count" title={`${sorted.length} agents in session`}>
          <span className="ap-h-pill total" aria-hidden>
            <span className="ap-h-sigma">Σ</span>
            <span className="ap-h-total-n">{sorted.length}</span>
          </span>
        </span>
      </div>
      <div className="agent-list reveal-stagger">
        {sorted.map((agent, i) => {
          const isActive = highlight === agent.path;
          const isStreaming = !!streamingByAgent[agent.path];
          // Only surface files the agent actually MODIFIED (write / edit /
          // patch). Pure reads (op:'read' — e.g. opening engine/library source
          // like camera.ts / world.ts to learn the API) are not the agent's
          // "work product" and aren't editable here, so listing them as if
          // they were project files is misleading (and clicking them only led
          // to read-only engine source). Filter reads out BEFORE dedupe so a
          // file that was read-then-written still shows via its write touch.
          const files = dedupeFiles(
            (fileActivity[agent.path] ?? []).filter((f) => f.op !== 'read'),
          );
          const gradient = gradFor(agent.path);
          const role = agent.parent === null ? 'orchestrator' : 'sub-agent';
          const statusLabel = isStreaming ? 'streaming' : agent.running ? 'running' : 'idle';
          return (
            <LiveAgentCard
              key={agent.path}
              agent={agent}
              gradient={gradient}
              role={role}
              statusLabel={statusLabel}
              files={files}
              active={isActive}
              tabbable={tabbableId === agent.path}
              motionIndex={i}
              onSelect={() => { setHighlight(agent.path); openAgentDetail(agent.path); }}
              onKey={(e) => onRowKey(e, agent.path)}
              onFileClick={(path) => { void openFile(path); }}
              buttonRefs={rowButtonRefs}
            />
          );
        })}
      </div>
    </div>
  );
}

function LiveAgentCard({
  agent, gradient, role, statusLabel, files, active, tabbable, motionIndex, onSelect, onKey, onFileClick, buttonRefs,
}: {
  agent: LiveAgent;
  gradient: string;
  role: string;
  statusLabel: string;
  files: AgentFileTouch[];
  active: boolean;
  tabbable: boolean;
  motionIndex: number;
  onSelect: () => void;
  onKey: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onFileClick: (path: string) => void;
  buttonRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
}): ReactNode {
  const { t } = useTranslation();
  const isMain = agent.parent === null;
  const setButtonRef = (el: HTMLButtonElement | null) => {
    if (el) buttonRefs.current.set(agent.path, el);
    else buttonRefs.current.delete(agent.path);
  };
  return (
    <div
      className={`agent-card ${active ? 'selected' : ''} ${isMain ? 'main' : 'sub'}`}
      data-role={role}
      data-agent-id={agent.path}
      style={{ '--i': motionIndex } as CSSProperties}
    >
      <button
        ref={setButtonRef}
        className="ac-row"
        onClick={onSelect}
        onKeyDown={onKey}
        title={`${agent.display} · ${role} · ${statusLabel}`}
        role="option"
        aria-selected={active}
        tabIndex={tabbable ? 0 : -1}
      >
        {/* ADR-0019: 列表视图 - mode='idle' 循环播 default (期待), 不参与对话状态机.
         *  size 跟 .ac-avatar (32px) 对齐; 不传 className=ac-avatar 因为 .ac-avatar 自带
         *  display:inline-flex 文字居中, 跟 video 不冲突但容易踩 background 渲染奇怪. */}
        <AgentAvatarVideo
          agentId={agent.path}
          mode="idle"
          size={32}
          shape="circle"
          fallback={
            <span className="ac-avatar" style={{ background: gradient }}>{initialFor(agent.display)}</span>
          }
        />
        <span className="ac-name-block">
          <span className="ac-name">
            {isMain && <span className="ac-main-pin" aria-label={t('agentsPanel.mainAgent')}>★</span>}
            {agent.display}
          </span>
          <span className="ac-role">
            <span className="ac-role-dot" aria-hidden="true" />
            {role} · {statusLabel}
          </span>
        </span>
        <span className="ac-badge">{files.length}</span>
      </button>
      {files.length > 0 && (
        <div className="ac-files">
          {files.map((f) => (
            <button
              key={f.path}
              className="ac-file"
              title={`${f.path} · ${f.op}`}
              onClick={(e) => { e.stopPropagation(); onFileClick(f.path); }}
            >
              <span className="ac-fi"><FileGlyph name={f.name} /></span>
              <span className="ac-fn">{f.name}</span>
              <span className={`ac-fs ${f.status === 'done' ? 'done' : f.status === 'running' ? 'running' : 'error'}`} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
