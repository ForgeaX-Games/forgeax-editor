// Game-directory open modal and project-id synchronisation.
//
// A Studio project is exactly one game directory. The runtime host may mount
// that directory internally for the engine, but it is never exposed as a
// project/game directory to the user.
import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useShellStore } from '../../store';
import { FsBrowser } from './FsBrowser';
import './FsBrowser.css';
import './TopBar.css';

export function GameDirectoryModalHost() {
  const open = useShellStore((s) => s.gameDirectoryModalOpen);
  const close = useShellStore((s) => s.closeGameDirectoryModal);
  if (!open) return null;
  return <OpenGameDirectoryModal onClose={close} />;
}

function OpenGameDirectoryModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setActiveGame = useShellStore((s) => s.setActiveGame);

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
      await setActiveGame(j.slug);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="tb-modal-overlay" onClick={onClose}>
      <div className="tb-modal tb-modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="tb-modal-title">{t('gameDirectory.openTitle')}</div>
        <FsBrowser
          initialDir="~"
          onPick={submitOpen}
          onCancel={onClose}
          busy={busy}
          externalError={err}
        />
      </div>
    </div>
  );
}
