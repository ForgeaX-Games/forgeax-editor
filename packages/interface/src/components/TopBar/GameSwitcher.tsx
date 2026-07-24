// Game modal host + New Game modal + timeSince helper.
//
// 2026-07-23 — the always-on GameSwitcher dropdown was removed from the TopBar.
// The File menu now drives games: 新建项目 → new-game dialog (game.new), and
// 打开项目 / 打开最近 → a centered "open game" modal whose body is the game list
// (game.open). This file exports `GameModalHost` (mounted once in App.tsx);
// `NewGameModal` + `timeSince` stay internal. The store flag `gameSwitcherOpen`
// now means "the open-game list modal is open".
import { useState, useEffect } from 'react';
import { Trash2 } from 'lucide-react';
import { useShellStore } from '../../store';
import { getSessionClient } from '../../store-parts/session-client';
import { getWorkbenchClient } from '../../store';
import { confirmDialog, alertDialog } from '../../lib/dialog';
import { useTranslation } from '@/i18n';
import './TopBar.css';

interface GameRow {
  slug: string;
  name: string;
  fileCount: number;
  mtime: number;
}

// Mounted once in the shell (App.tsx). Renders the new-game dialog (game.new)
// and the "open game" list modal (game.open), both driven by the shell store so
// the File-menu commands can open them.
export function GameModalHost() {
  const { t } = useTranslation();
  const listOpen = useShellStore((s) => s.gameSwitcherOpen);
  const setListOpen = useShellStore((s) => s.setGameSwitcherOpen);
  const gameModalOpen = useShellStore((s) => s.gameModalOpen);
  const closeGameModal = useShellStore((s) => s.closeGameModal);
  const [games, setGames] = useState<GameRow[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const pinnedSlug = useShellStore((s) => s.pinnedSlug);
  const setPinnedSlug = useShellStore((s) => s.setPinnedSlug);
  const switchGame = useShellStore((s) => s.switchGame);

  const currentSlug = pinnedSlug ?? activeSlug;

  const reload = async () => {
    try {
      const j = await getWorkbenchClient().listGames();
      setGames((j.games as unknown as GameRow[]) ?? []);
      setActiveSlug(j.activeSlug ?? null);
    } catch { /* ignore */ }
  };

  // Load the game list when the "open game" modal opens (was a 6s poll on the
  // always-on switcher; now on-demand since the list only shows in the modal).
  useEffect(() => { if (listOpen) void reload(); }, [listOpen]);

  // Picking a game goes through store.switchGame — one mechanism shared with 新建
  // game: it pins the game client-side (preview / agents scoping), tells the
  // server to make it the active game, re-scopes the session list and lands on
  // its most-recent session (creating one when the game has none).
  const onPick = async (slug: string) => {
    setListOpen(false);
    await switchGame(slug);
  };

  const onDelete = async (slug: string) => {
    if (!(await confirmDialog({ body: t('gameSwitcher.deleteConfirm', { slug }), danger: true }))) return;
    try {
      await getWorkbenchClient().deleteGame(slug);
      if (pinnedSlug === slug) setPinnedSlug(null);
      await reload();
    } catch (e) {
      void alertDialog({ title: t('gameSwitcher.deleteFailedTitle'), body: (e as Error).message });
    }
  };

  return (
    <>
      {gameModalOpen && <NewGameModal onClose={() => { closeGameModal(); }} />}
      {listOpen && (
        <div className="tb-modal-overlay" onClick={() => setListOpen(false)}>
          <div className="tb-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tb-modal-title">{t('gameSwitcher.listTitle')}</div>
            {/* Plain in-modal flow container — NOT `.tb-game-dropdown` (that class
                is absolutely positioned for the old popover and would jump to the
                corner). The modal card supplies the chrome; rows style themselves. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, maxHeight: '60vh', overflowY: 'auto', marginTop: 4 }}>
              {games.length === 0 && (
                <div className="tb-game-empty">{t('gameSwitcher.empty')}</div>
              )}
              {games.map((g) => (
                <div key={g.slug} className={`tb-game-row ${g.slug === currentSlug ? 'active' : ''}`} data-game-slug={g.slug}>
                  <button
                    className="tb-game-pick"
                    onClick={() => void onPick(g.slug)}
                    title={t('gameSwitcher.switchToTooltip', { slug: g.slug })}
                  >
                    <span className="tb-game-name">{g.name}</span>
                    <span className="tb-game-meta">{t('gameSwitcher.gameMeta', { count: g.fileCount, time: timeSince(g.mtime) })}</span>
                  </button>
                  <button
                    className="tb-game-del"
                    onClick={() => void onDelete(g.slug)}
                    title={t('gameSwitcher.deleteTooltip')}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
              {pinnedSlug && (
                <button className="tb-game-row reset" onClick={() => { setPinnedSlug(null); setListOpen(false); }}>
                  <span style={{ flex: 1, textAlign: 'left' }}>{t('gameSwitcher.unpin')}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ProjectSwitcher + NewProjectModal + activateWorkspace extracted → ./ProjectSwitcher (§D).

function timeSince(ms: number): string {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return `${Math.floor(d)}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}


function NewGameModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const switchGame = useShellStore((s) => s.switchGame);

  const submit = async () => {
    const cleaned = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(cleaned)) {
      setErr(t('gameSwitcher.slugError'));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const j = await getWorkbenchClient().createGame({ slug: cleaned, name: name.trim() || cleaned, brief: brief.trim() });
      if (!j.ok) {
        setErr(j.error ?? 'create failed');
        setBusy(false);
        return;
      }
      // Server already marked games/<slug>/ as the active game. switchGame pins it
      // client-side AND — since a brand-new game has no sessions — auto-creates one
      // bound to it ("新建 game 必带 session"), landing the user on a fresh session
      // scoped to the new game before the kickoff message goes out.
      await switchGame(cleaned);
      onClose();
      // Kick Forge with the brief so the design pipeline starts immediately.
      // Emit straight onto the new session's EventBus (server reflects
      // user_input → chat session-stream renders it). The shell never imports
      // chat — the bus IS the app-agnostic send channel.
      if (brief.trim()) {
        const st = useShellStore.getState();
        const sid = st.activeSid;
        if (sid) {
          const to = st.tabs.find((tb) => tb.sid === sid)?.agentId ?? undefined;
          void getSessionClient().emitForgeaXMessage(sid, t('gameSwitcher.kickoffMessage', { slug: cleaned, brief: brief.trim() }), to ? { to } : {});
        }
      }
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="tb-modal-overlay" onClick={onClose}>
      <div className="tb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tb-modal-title">{t('gameSwitcher.modalTitle')}</div>
        <label className="tb-modal-label">{t('gameSwitcher.slugLabel')}</label>
        <input
          autoFocus
          className="tb-modal-input"
          placeholder="e.g. roguelike-deckbuilder"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
        />
        <label className="tb-modal-label">{t('gameSwitcher.nameLabel')}</label>
        <input
          className="tb-modal-input"
          placeholder={t('gameSwitcher.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="tb-modal-label">{t('gameSwitcher.briefLabel')}</label>
        <textarea
          className="tb-modal-textarea"
          placeholder={t('gameSwitcher.briefPlaceholder')}
          rows={3}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
        />
        {err && <div className="tb-modal-error">{err}</div>}
        <div className="tb-modal-actions">
          <button className="tb-modal-btn" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button className="tb-modal-btn primary" onClick={submit} disabled={busy}>
            {busy ? t('gameSwitcher.creating') : t('gameSwitcher.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
