// GameSwitcher (per-game switcher) + its New Game modal + timeSince helper,
// extracted from TopBar.tsx (§D).
import { useState, useEffect } from 'react';
import { Gamepad2, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAppStore } from '../../store';
import { confirmDialog, alertDialog } from '../../lib/dialog';
import './TopBar.css';

interface GameRow {
  slug: string;
  name: string;
  fileCount: number;
  mtime: number;
}

export function GameSwitcher() {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<null | 'game'>(null);
  const [games, setGames] = useState<GameRow[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const pinnedSlug = useAppStore((s) => s.pinnedSlug);
  const setPinnedSlug = useAppStore((s) => s.setPinnedSlug);

  const currentSlug = pinnedSlug ?? activeSlug;
  const currentGame = games.find((g) => g.slug === currentSlug);

  const reload = async () => {
    try {
      const r = await fetch('/api/workbench/games');
      const j = (await r.json()) as { games?: GameRow[]; activeSlug?: string };
      setGames(j.games ?? []);
      setActiveSlug(j.activeSlug ?? null);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    reload();
    const t = setInterval(reload, 6000);
    return () => clearInterval(t);
  }, []);

  // Picking a game pins it client-side (preview / agents scoping) AND tells the
  // server to make it the active game — which relocates every live session's
  // cli working directory into games/<slug>/ so the agent's shell/pwd follows.
  const onPick = async (slug: string) => {
    setPinnedSlug(slug);
    setOpen(false);
    try {
      const r = await fetch(`/api/workbench/games/${slug}/activate`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await reload();
    } catch (e) {
      // The client-side pin already switched the preview, but the server didn't
      // record the active game — so agent cwd / system-prompt scope / products
      // may still point at the previous game. Surface it instead of silently
      // leaving that mismatch in place.
      void alertDialog({
        title: '切换游戏未完全生效',
        body: `预览已切到 ${slug}，但服务端激活失败（${(e as Error).message}）。Agent 的工作目录与产出物可能仍指向旧游戏，可重试或刷新。`,
      });
    }
  };

  const onDelete = async (slug: string) => {
    if (!(await confirmDialog({ body: `确认删除 games/${slug}/ ？此操作不可撤销。`, danger: true }))) return;
    try {
      await fetch(`/api/workbench/games/${slug}`, { method: 'DELETE' });
      if (pinnedSlug === slug) setPinnedSlug(null);
      await reload();
    } catch (e) {
      void alertDialog({ title: '删除失败', body: (e as Error).message });
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
    <div className="tb-game-switcher tb-game-switcher--game">
      <PopoverTrigger asChild>
        <button
          className="tb-game-btn"
          title="切换游戏（每个游戏 = 一个 game）"
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
            title="在当前 workspace 下新建一个 .forgeax/games/<slug>/（Iori/Suzu 设计 + Forge 写代码）"
          >
            <Plus size={12} style={{ marginRight: 4 }} />
            <span className="tb-game-name">新建 game</span>
          </button>
          {games.length === 0 && (
            <div className="tb-game-empty">暂无 game · 点上方 + 新建</div>
          )}
          {games.map((g) => (
            <div key={g.slug} className={`tb-game-row ${g.slug === currentSlug ? 'active' : ''}`} data-game-slug={g.slug}>
              <button
                className="tb-game-pick"
                onClick={() => void onPick(g.slug)}
                title={`切到 games/${g.slug}/`}
              >
                <span className="tb-game-name">{g.name}</span>
                <span className="tb-game-meta">{g.fileCount} files · {timeSince(g.mtime)}</span>
              </button>
              <button
                className="tb-game-del"
                onClick={() => void onDelete(g.slug)}
                title="删除 game"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
          {pinnedSlug && (
            <button className="tb-game-row reset" onClick={() => { setPinnedSlug(null); setOpen(false); }}>
              <span style={{ flex: 1, textAlign: 'left' }}>取消固定 — 跟随最新</span>
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
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const setPinnedSlug = useAppStore((s) => s.setPinnedSlug);

  const submit = async () => {
    const cleaned = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(cleaned)) {
      setErr('slug: 2-41 字符 / 小写 ASCII / 数字 / 连字符');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/workbench/games', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: cleaned, name: name.trim() || cleaned, brief: brief.trim() }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) {
        setErr(j.error ?? `HTTP ${r.status}`);
        setBusy(false);
        return;
      }
      // Server already marked games/<slug>/ as the active game + relocated live
      // sessions' cli there; pin it client-side too so preview/agents follow.
      setPinnedSlug(cleaned);
      onClose();
      // Kick Forge with the brief so the design pipeline starts immediately.
      if (brief.trim()) {
        void sendMessage(`刚创建了 games/${cleaned}/，brief：${brief.trim()}。请走完 Iori → Suzu → 你自己写代码的流水线。`);
      }
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="tb-modal-overlay" onClick={onClose}>
      <div className="tb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tb-modal-title">新建项目</div>
        <label className="tb-modal-label">slug (项目目录名)</label>
        <input
          autoFocus
          className="tb-modal-input"
          placeholder="e.g. roguelike-deckbuilder"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
        />
        <label className="tb-modal-label">显示名（可选）</label>
        <input
          className="tb-modal-input"
          placeholder="留空用 slug"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="tb-modal-label">brief（可选 — 留下 Forge 立刻派 Iori 立柱）</label>
        <textarea
          className="tb-modal-textarea"
          placeholder="e.g. 2D 卡牌肉鸽，每局 5-10 分钟，攒套牌轰爽快感"
          rows={3}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
        />
        {err && <div className="tb-modal-error">{err}</div>}
        <div className="tb-modal-actions">
          <button className="tb-modal-btn" onClick={onClose} disabled={busy}>取消</button>
          <button className="tb-modal-btn primary" onClick={submit} disabled={busy}>
            {busy ? '创建中...' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Tiny inline component for the Dashboard toggle pill — kept here to avoid a
// new file for what is essentially a one-button widget. Mirrors the
// pill-icon-btn pattern used for Settings next to it.
