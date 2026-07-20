// GameSwitcher (per-game switcher) + its New Game modal + timeSince helper,
// extracted from TopBar.tsx (§D).
import { useState, useEffect } from 'react';
import { Gamepad2, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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

export function GameSwitcher() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<null | 'game'>(null);
  const [games, setGames] = useState<GameRow[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const pinnedSlug = useShellStore((s) => s.pinnedSlug);
  const setPinnedSlug = useShellStore((s) => s.setPinnedSlug);
  const switchGame = useShellStore((s) => s.switchGame);

  const currentSlug = pinnedSlug ?? activeSlug;
  const currentGame = games.find((g) => g.slug === currentSlug);

  const reload = async () => {
    try {
      const j = await getWorkbenchClient().listGames();
      setGames((j.games as unknown as GameRow[]) ?? []);
      setActiveSlug(j.activeSlug ?? null);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    reload();
    const timer = setInterval(reload, 6000);
    return () => clearInterval(timer);
  }, []);

  // Picking a game goes through store.switchGame — one mechanism shared with 新建
  // game: it pins the game client-side (preview / agents scoping), tells the server
  // to make it the active game (relocating live sessions' cli into games/<slug>/),
  // re-scopes the session list to this game and lands on its most-recent session
  // (creating one when the game has none). Activate-failure surfacing lives inside
  // switchGame; here we just refresh this switcher's own games list afterwards.
  const onPick = async (slug: string) => {
    setOpen(false);
    await switchGame(slug);
    await reload();
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
    <Popover open={open} onOpenChange={setOpen}>
    <div className="tb-game-switcher tb-game-switcher--game">
      <PopoverTrigger asChild>
        <button
          className="tb-game-btn"
          title={t('gameSwitcher.switchTooltip')}
        >
          <Gamepad2 size={16} />
          <span className="tb-game-label">{currentGame?.name ?? currentSlug ?? '_template'}</span>
          <ChevronDown size={16} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-auto border-0 bg-transparent p-0 shadow-none">
        <div className="tb-game-dropdown tb-game-dropdown--popover" style={{ minWidth: 280 }}>
          {/* Pinned "新建 game" at the top — mirrors SessionSwitcher's pinned
              "新建 session" so every selector owns its own create action and we
              don't need a separate global "+" button. */}
          <button
            type="button"
            className="tb-game-pick"
            onClick={() => { setOpen(false); setModal('game'); }}
            style={{
              borderBottom: '1px solid var(--color-border-subtle)',
              color: 'var(--color-role-art)',
              position: 'sticky',
              top: -4,
              background: 'var(--bg-2)',
              zIndex: 1,
            }}
            title={t('gameSwitcher.newGameTooltip')}
          >
            <Plus size={12} style={{ marginRight: 4 }} />
            <span className="tb-game-name">{t('gameSwitcher.newGame')}</span>
          </button>
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
            <button className="tb-game-row reset" onClick={() => { setPinnedSlug(null); setOpen(false); }}>
              <span style={{ flex: 1, textAlign: 'left' }}>{t('gameSwitcher.unpin')}</span>
            </button>
          )}
        </div>
      </PopoverContent>
      {modal === 'game' && <NewGameModal onClose={() => { setModal(null); void reload(); }} />}
    </div>
    </Popover>
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

// Tiny inline component for the Dashboard toggle pill — kept here to avoid a
// new file for what is essentially a one-button widget. Mirrors the
// pill-icon-btn pattern used for Settings next to it.
