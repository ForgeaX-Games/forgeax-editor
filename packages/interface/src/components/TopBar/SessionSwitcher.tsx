// SessionSwitcher — extracted from TopBar.tsx (§D). Reads store.tabs (the
// single derived view of the server session list) so TopBar dropdown / TabStrip
// never disagree. New/switch/close all go through the store actions.
import { useState, useEffect } from 'react';
import { History, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t, useTranslation } from '@/i18n';
import { useShellStore } from '../../store';
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
  if (deltaMs < 0) return t('sessionSwitcher.justNow'); // clock skew → treat as just now, not future
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return t('sessionSwitcher.justNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('sessionSwitcher.minutesAgo', { min });
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
  if (dayDiff === 1) return t('sessionSwitcher.yesterdayTime', { time: `${hh}:${mm}` });
  if (dayDiff < 7) return t('sessionSwitcher.daysAgo', { dayDiff });
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const pinnedSlug = useShellStore((s) => s.pinnedSlug);
  const activeSid = useShellStore((s) => s.activeSid);
  const tabs = useShellStore((s) => s.tabs);
  const busyByAgentBySid = useShellStore((s) => s.busyByAgentBySid);
  const createNewSession = useShellStore((s) => s.createNewSession);
  const switchToSession = useShellStore((s) => s.switchToSession);
  const closeSession = useShellStore((s) => s.closeSession);
  const refreshSessions = useShellStore((s) => s.refreshSessions);

  // Dropdown open / pinnedSlug 变化时刷新一次 server list（防止外部进程直接
  // 改了 ~/.forgeax/sessions/ 后 UI 看不到）。
  useEffect(() => {
    if (!open) return;
    void refreshSessions();
  }, [open, pinnedSlug, refreshSessions]);

  const onDelete = async (sid: string) => {
    if (!(await confirmDialog({ body: t('sessionSwitcher.deleteConfirm'), danger: true }))) return;
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
    || (activeTab ? `session ${activeTab.sid.slice(0, 6)}` : t('common.loading'));

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
          title={activeTab ? t('sessionSwitcher.triggerActive', { label: activeLabel }) : t('sessionSwitcher.triggerEmpty')}
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
            title={t('sessionSwitcher.newSessionTitle')}
          >
            <Plus size={12} style={{ marginRight: 4 }} />
            <span className="tb-game-name">{t('sessionSwitcher.newSession')}</span>
            <span className="tb-game-meta">{pinnedSlug ? t('sessionSwitcher.projectBound', { slug: pinnedSlug }) : t('sessionSwitcher.projectUnbound')}</span>
          </button>
          {sortedTabs.length === 0 && (
            <div className="tb-game-empty">{t('sessionSwitcher.empty')}</div>
          )}
          {sortedTabs.map((tab) => {
            const isActive = tab.sid === activeSid;
            const label = tab.displayName?.trim() || `session ${tab.sid.slice(0, 6)}`;
            const rel = formatRelative(tab.lastActivityAt);
            const isBusy = Object.values(busyByAgentBySid[tab.sid] ?? {}).some(Boolean);
            return (
              <div key={tab.sid} className={`tb-game-row ${isActive ? 'is-active' : ''}`} data-session-id={tab.sid} data-session-name={label}>
                <button
                  className="tb-game-pick"
                  onClick={() => void onPick(tab.sid)}
                  title={`sid: ${tab.sid}${tab.agentId ? ` · agent: ${tab.agentId}` : ''}${tab.lastActivityAt ? ` · ${t('sessionSwitcher.lastActive', { time: new Date(tab.lastActivityAt).toLocaleString() })}` : ''}`}
                >
                  <span className="tb-game-name">
                    {label}
                    {isActive && <span style={{ marginLeft: 6, color: 'var(--color-role-art)' }}>·</span>}
                  </span>
                  <span className="tb-game-meta">
                    {tab.sid.slice(0, 8)}{tab.agentId ? ` · ${tab.agentId}` : ''}{isBusy ? ' · ●' : ''}{rel ? ` · ${rel}` : ''}
                  </span>
                </button>
                <button
                  className="tb-game-del"
                  onClick={() => void onDelete(tab.sid)}
                  title={t('sessionSwitcher.deleteTitle')}
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

