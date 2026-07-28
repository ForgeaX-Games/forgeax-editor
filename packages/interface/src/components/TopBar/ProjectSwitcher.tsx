// Game-directory open modal + headless project-id sync.
//
// 2026-07-23 — the ProjectSwitcher dropdown (trigger + project list +
// current-name + delete) was removed from the TopBar. File → 打开项目 now picks
// a game directory and links it through /api/workbench/games/link. It does not
// change the Studio instance root.
import { useState, useEffect } from 'react';
import { useTranslation } from '@/i18n';
import { useShellStore } from '../../store';
import { setCurrentProject } from '../../lib/workbenches';
import { FsBrowser } from './FsBrowser';
import './FsBrowser.css';
import './TopBar.css';

// Headless: keep the active project id in sync so every localStorage read/write
// namespaces under `forgeax:project:${projId}:*` (was previously driven by the
// ProjectSwitcher's polling). Idempotent for the same id.
function useProjectIdSync(): string | null {
  const [gamesDir, setGamesDir] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      try {
        const r = await fetch('/api/projects');
        const j = (await r.json()) as { current?: string; currentAbs?: string };
        if (!cancelled) {
          setCurrentProject(j.current ?? 'default');
          setGamesDir(j.currentAbs
            ? `${j.currentAbs.replace(/[\\/]$/, '')}/.forgeax/games`
            : null);
        }
      } catch { /* ignore */ }
    };
    void sync();
    const timer = setInterval(() => void sync(), 8000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  return gamesDir;
}

// Mounted once in the shell (App.tsx). Drives the game-directory picker from
// File → Open Project and runs the headless project-id sync.
export function GameDirectoryModalHost() {
  const gamesDir = useProjectIdSync();
  const open = useShellStore((s) => s.gameDirectoryModalOpen);
  const close = useShellStore((s) => s.closeGameDirectoryModal);
  if (!open) return null;
  return <OpenGameDirectoryModal initialDir={gamesDir} onClose={close} />;
}

function OpenGameDirectoryModal({
  initialDir,
  onClose,
}: {
  initialDir: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const switchGame = useShellStore((s) => s.switchGame);

  const submitOpen = async (absPath: string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/workbench/games/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: absPath }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string; slug?: string };
      if (!r.ok || !j.ok || !j.slug) throw new Error(j.error ?? `HTTP ${r.status}`);
      onClose();
      await switchGame(j.slug);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <div className="tb-modal-overlay" onClick={onClose}>
      <div className="tb-modal tb-modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="tb-modal-title">{t('projectSwitcher.openGameDirectory')}</div>
        {initialDir ? (
          <FsBrowser
            initialDir={initialDir}
            onPick={submitOpen}
            onCancel={onClose}
            busy={busy}
            externalError={err}
          />
        ) : (
          <div className="fsb-state">{t('common.loading')}</div>
        )}
      </div>
    </div>
  );
}

// SessionSwitcher extracted → ./SessionSwitcher (§D).
