import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ChevronDown, Sparkles } from 'lucide-react';
import { useAppStore } from '../../store';
import { listSessionAgents, type ForgeaXAgentNode } from '../../lib/forgeax-bridge';

/**
 * Upper-right picker rendered inside the workbench plugin host bar.
 *
 * Iter-1 (single-panel mode): clicking an agent rebinds the active tab's
 * `agentId` via `setTabAgent` — same single trigger ChatPanel watches for
 * WAL replay. Iter-2 will turn this into per-agent independent panels.
 *
 * `preferredAgentPluginId` is a soft hint declared in the workbench plugin
 * manifest (provides.workbench.preferredAgent). When the active tab has no
 * matching agent yet, we badge the matching session agent to surface the
 * intent, but never lock the user — they can pick anything in the dropdown.
 */
export function WorkbenchAgentPicker({
  preferredAgentPluginId,
}: {
  preferredAgentPluginId?: string;
}): ReactElement | null {
  const activeSid = useAppStore((s) => s.activeSid);
  const setTabAgent = useAppStore((s) => s.setTabAgent);
  const activeAgentId = useAppStore(
    (s) => s.tabs.find((t) => t.sid === s.activeSid)?.agentId ?? null,
  );

  const [agents, setAgents] = useState<ForgeaXAgentNode[]>([]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeSid) { setAgents([]); return; }
    let cancelled = false;
    const tick = () => {
      listSessionAgents(activeSid)
        .then((list) => { if (!cancelled) setAgents(list); })
        .catch(() => { /* ignore — surface stays muted */ });
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeSid]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [open]);

  const preferredKey = pluginIdToAgentKey(preferredAgentPluginId);
  const preferredMatch = preferredKey
    ? agents.find((a) => agentMatches(a, preferredKey))
    : null;

  const active = agents.find((a) => a.path === activeAgentId) ?? null;
  const label = active?.display ?? '未绑定';

  return (
    <div className="wb-agent-picker" ref={rootRef}>
      <button
        className="wb-agent-picker-btn"
        onClick={() => setOpen((v) => !v)}
        title={preferredMatch
          ? `当前对话目标 · 推荐 ${preferredMatch.display}`
          : '当前对话目标'}
      >
        <span className="wb-agent-picker-name">{label}</span>
        {preferredMatch && active?.path !== preferredMatch.path && (
          <Sparkles size={11} className="wb-agent-picker-hint" />
        )}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="wb-agent-picker-menu" role="listbox">
          {agents.length === 0 && (
            <div className="wb-agent-picker-empty">无可用 agent</div>
          )}
          {agents.map((a) => {
            const isActive = a.path === activeAgentId;
            const isPreferred = preferredMatch?.path === a.path;
            return (
              <button
                key={a.path}
                className={`wb-agent-picker-item ${isActive ? 'active' : ''}`}
                onClick={() => {
                  if (activeSid) setTabAgent(activeSid, a.path);
                  setOpen(false);
                }}
                role="option"
                aria-selected={isActive}
              >
                <span>{a.display}</span>
                {isPreferred && <Sparkles size={11} className="wb-agent-picker-hint" />}
              </button>
            );
          })}
          {preferredAgentPluginId && !preferredMatch && (
            <div className="wb-agent-picker-empty" style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
              推荐 <code>{preferredAgentPluginId}</code> 未在当前 session 中
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Strip the `@scope/agent-` prefix from a plugin id to get the agent key
 *  used as `provides.agent.id` (e.g. `@forgeax-plugin/agent-cc-coder` →
 *  `cc-coder`). Returns null if the input is empty / not a plugin id. */
function pluginIdToAgentKey(pluginId?: string): string | null {
  if (!pluginId) return null;
  const last = pluginId.split('/').pop() ?? '';
  return last.startsWith('agent-') ? last.slice('agent-'.length) : last;
}

/** Match an agent node to a `provides.agent.id` key. Session agent paths /
 *  displays often look like `cc-coder` or `cc-coder#1`; we match by prefix
 *  to tolerate multi-instance suffixes. */
function agentMatches(node: ForgeaXAgentNode, key: string): boolean {
  if (node.path === key || node.display === key) return true;
  if (node.path.startsWith(`${key}#`) || node.display.startsWith(`${key}#`)) return true;
  if (node.fullId === key || node.fullId.startsWith(`${key}#`)) return true;
  return false;
}
