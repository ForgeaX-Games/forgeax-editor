/**
 * CheckpointsDrawer — the "检查点" bottom-drawer panel (demo `data-rt=
 * "checkpoints"`). A timeline of the active session's rewind checkpoints, newest
 * at the top, with the current HEAD highlighted.
 *
 * REAL data: session-level rewind anchors via checkpoint-api
 * (GET /api/sessions/:sid/checkpoints). Each user message snapshots the game dir
 * (CheckpointManager); `hasCode=false` means a pure-conversation turn. The list
 * has no commit-message text (only msgId), so rows show a code/conversation
 * label + short id + time. A `drawer` panel (ADR-0030 §2.3), contributed by
 * chrome-drawer.tsx next to Info.
 */
import { useEffect, useState } from 'react';
import type { DrawerPanelContribution } from '../../../core/panels';
import { useShellStore } from '../../../store';
import { fetchCheckpoints, type CheckpointEntry, type PendingRewindInfo } from '../../../lib/checkpoint-api';
import './footer.css';

/** epoch ms → "HH:MM:SS". */
function fmtTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function CheckpointsDrawer() {
  const activeSid = useShellStore((s) => s.activeSid);
  const [items, setItems] = useState<readonly CheckpointEntry[]>([]);
  const [pending, setPending] = useState<PendingRewindInfo | null>(null);

  useEffect(() => {
    if (!activeSid) {
      setItems([]);
      setPending(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const { checkpoints, pending: p } = await fetchCheckpoints(activeSid);
        if (cancelled) return;
        setItems(checkpoints);
        setPending(p);
      } catch {
        if (!cancelled) {
          setItems([]);
          setPending(null);
        }
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeSid]);

  if (items.length === 0) {
    return <div className="fx-drawer-content"><div className="fx-empty">{activeSid ? '暂无检查点' : '未连接会话'}</div></div>;
  }

  // API order is chronological (oldest first); show newest at the top. The
  // current HEAD is the pending rewind target if any, else the latest anchor.
  const total = items.length;
  const headMsgId = pending?.targetMsgId ?? items[total - 1]?.msgId;

  return (
    <div className="fx-drawer-content">
      {items
        .map((c, i) => ({ c, n: i + 1 }))
        .reverse()
        .map(({ c, n }) => {
          const head = c.msgId === headMsgId;
          return (
            <div key={c.msgId} className={`fx-ck${head ? ' head' : ''}`}>
              <div className="dot" />
              <div>
                <div className="ck-msg">{c.hasCode ? '代码 + 会话快照' : '会话快照'}</div>
                <div className="ck-meta">
                  {`#${n}`} · {c.msgId.slice(0, 8)} · {fmtTime(c.ts)}
                  {head ? (
                    <>
                      {' · '}
                      <span className="cur">当前 HEAD</span>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
    </div>
  );
}

export const checkpointsDrawerPanel: DrawerPanelContribution = {
  id: 'checkpoints',
  title: 'Checkpoints',
  titleKey: 'footerPanel.checkpoints',
  icon: 'History',
  order: 1,
  render: () => <CheckpointsDrawer />,
};
