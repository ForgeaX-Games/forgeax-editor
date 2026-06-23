// SessionSwitcher — extracted from TopBar.tsx (§D). Reads store.tabs (the
// single derived view of the server session list) so TopBar dropdown / TabStrip
// never disagree. New/switch/close all go through the store actions.
import { useState, useEffect } from 'react';
import { History, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAppStore } from '../../store';
import { confirmDialog } from '../../lib/dialog';
import './TopBar.css';

// 把 epoch-ms 渲染成相对/绝对时间标签。短窗口（<1h）走"X 分钟前"给手感
// 强；当天走"HH:MM"；昨天 / 7 天内走"昨天 HH:MM" / "周X HH:MM"；再老就直
// 接给日期 "MM-DD"。所有计算都在调用时拿 Date.now() 即时算，下拉每次开都
// 重算，不需要 hook 心跳 —— 用户开-看-关的窗口里时间不会"卡"。
function formatRelative(ts: number | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const now = Date.now();
  const deltaMs = now - ts;
  if (deltaMs < 0) return '刚刚'; // clock skew → treat as just now, not future
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  // Compare calendar days using local-time midnight so "昨天" is intuitive
  // across midnight rather than purely a 24-hour rolling window.
  const tsDate = new Date(ts);
  const nowDate = new Date(now);
  const dayDiff = Math.floor(
    (Date.UTC(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate())
      - Date.UTC(tsDate.getFullYear(), tsDate.getMonth(), tsDate.getDate()))
    / 86_400_000,
  );
  const hh = String(tsDate.getHours()).padStart(2, '0');
  const mm = String(tsDate.getMinutes()).padStart(2, '0');
  if (dayDiff === 0) return `${hh}:${mm}`;
  if (dayDiff === 1) return `昨天 ${hh}:${mm}`;
  if (dayDiff < 7) return `${dayDiff} 天前`;
  // Older than a week — yyyy-mm-dd if cross-year, mm-dd otherwise.
  const M = String(tsDate.getMonth() + 1).padStart(2, '0');
  const D = String(tsDate.getDate()).padStart(2, '0');
  return tsDate.getFullYear() === nowDate.getFullYear()
    ? `${M}-${D}`
    : `${tsDate.getFullYear()}-${M}-${D}`;
}

// R3 (2026-05-20 重做) —— SessionSwitcher 直接读 store.tabs（= server session
// list 的派生 view）。不再独立维护 sessions[] state、不再调 GET /api/sessions：
// 那一份 fetch 由 store.refreshSessions 统一管，保证 TopBar dropdown / TabStrip /
// 任何其它 surface 永远看到同一份 sessions 数据 —— 即用户痛感「TopBar 显示 X
// 但 TabStrip 显示 Y」根除。
//
// 操作语义：
//   - 新建 session  → store.createNewSession()    （POST /api/sessions + tab）
//   - 切 session   → store.switchToSession(sid)  （+ WS 重 attach + 持久化）
//   - 删 session   → store.closeSession(sid)     （DELETE + 自动切下一条）
export function SessionSwitcher() {
  const [open, setOpen] = useState(false);
  const pinnedSlug = useAppStore((s) => s.pinnedSlug);
  const activeSid = useAppStore((s) => s.activeSid);
  const tabs = useAppStore((s) => s.tabs);
  const createNewSession = useAppStore((s) => s.createNewSession);
  const switchToSession = useAppStore((s) => s.switchToSession);
  const closeSession = useAppStore((s) => s.closeSession);
  const refreshSessions = useAppStore((s) => s.refreshSessions);

  // Dropdown open / pinnedSlug 变化时刷新一次 server list（防止外部进程直接
  // 改了 ~/.forgeax/sessions/ 后 UI 看不到）。
  useEffect(() => {
    if (!open) return;
    void refreshSessions();
  }, [open, pinnedSlug, refreshSessions]);

  const onDelete = async (sid: string) => {
    if (!(await confirmDialog({ body: '确认删除该 session?\nserver 上的 session 目录 + ledger 都会一起 rm。', danger: true }))) return;
    await closeSession(sid);
  };

  const onPick = async (sid: string) => {
    await switchToSession(sid);
    setOpen(false);
  };

  const onNew = async () => {
    const r = await createNewSession({ defaultDir: pinnedSlug ?? undefined });
    if (r) setOpen(false);
  };

  const activeTab = tabs.find((t) => t.sid === activeSid);
  const activeLabel = activeTab?.displayName?.trim()
    || (activeTab ? `session ${activeTab.sid.slice(0, 6)}` : '加载中…');

  // Dropdown-only sort by最后对话时间 desc — keep store.tabs in its
  // original order (TabStrip / persisted activeSid still index by it).
  // Sessions without lastActivityAt sink to the bottom; among those, sid
  // stable order. Fresh-created tabs (no on-disk activity yet) thus sit
  // at the bottom until the next refresh populates the field, which feels
  // wrong — bump them just-now (Date.now()) when the field is missing so
  // a brand-new session appears at the top of the list immediately.
  const now = Date.now();
  const sortedTabs = [...tabs].sort((a, b) => {
    const ta = a.lastActivityAt ?? now;
    const tb = b.lastActivityAt ?? now;
    return tb - ta;
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
    <div className="tb-session-switcher">
      <PopoverTrigger asChild>
        <button
          className="tb-game-btn"
          title={activeTab ? `当前 session: ${activeLabel}` : 'session 列表 (boot 中或服务器空)'}
        >
          <History size={16} />
          <span className="tb-game-label">{activeLabel}</span>
          <ChevronDown size={16} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-auto border-0 bg-transparent p-0 shadow-none">
        <div className="tb-game-dropdown tb-game-dropdown--popover" style={{ minWidth: 280 }}>
          <button
            type="button"
            className="tb-game-pick"
            onClick={() => void onNew()}
            style={{
              borderBottom: '1px solid var(--color-border-subtle)',
              color: 'var(--color-role-art)',
              /* dropdown 现在 max-height + 滚动,把 "+ 新建 session" 钉在顶部
                 不随列表滚走。top: -4px 抵消 dropdown 4px padding,贴齐边缘。 */
              position: 'sticky',
              top: -4,
              background: 'var(--bg-2)',
              zIndex: 1,
            }}
            title="新建一个 session（POST /api/sessions · scheduler 自动 start）"
          >
            <Plus size={12} style={{ marginRight: 4 }} />
            <span className="tb-game-name">新建 session</span>
            <span className="tb-game-meta">{pinnedSlug ? `项目 ${pinnedSlug}` : '未绑定项目'}</span>
          </button>
          {sortedTabs.length === 0 && (
            <div className="tb-game-empty">暂无 session · 点 + 新建</div>
          )}
          {sortedTabs.map((t) => {
            const isActive = t.sid === activeSid;
            const label = t.displayName?.trim() || `session ${t.sid.slice(0, 6)}`;
            const rel = formatRelative(t.lastActivityAt);
            return (
              <div key={t.sid} className={`tb-game-row ${isActive ? 'is-active' : ''}`} data-session-id={t.sid} data-session-name={label}>
                <button
                  className="tb-game-pick"
                  onClick={() => void onPick(t.sid)}
                  title={`sid: ${t.sid}${t.agentId ? ` · agent: ${t.agentId}` : ''}${t.lastActivityAt ? ` · 最后活跃 ${new Date(t.lastActivityAt).toLocaleString()}` : ''}`}
                >
                  <span className="tb-game-name">
                    {label}
                    {isActive && <span style={{ marginLeft: 6, color: 'var(--color-role-art)' }}>·</span>}
                  </span>
                  <span className="tb-game-meta">
                    {t.sid.slice(0, 8)}{t.agentId ? ` · ${t.agentId}` : ''}{t.isStreaming ? ' · ●' : ''}{rel ? ` · ${rel}` : ''}
                  </span>
                </button>
                <button
                  className="tb-game-del"
                  onClick={() => void onDelete(t.sid)}
                  title="删除 session（DELETE /api/sessions/:sid · ledger 一起清）"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </div>
    </Popover>
  );
}

