// FsBrowser — server-side directory picker. Used by NewProjectModal's
// "打开已有目录" tab to let the user pick an existing system directory as a
// ForgeaX workspace.
//
// Folder-only navigation (the server endpoint only returns dirs). Submitting
// posts to /api/projects/open which optionally scaffolds .forgeax/games/_default/
// so the preview iframe has something to render for non-game workspaces.

import { useCallback, useEffect, useState } from 'react';
import { ArrowUp, FolderOpen, Folder, Home, Loader2 } from 'lucide-react';
import { useTranslation } from '@/i18n';

interface BrowseEntry {
  name: string;
  isDir: boolean;
  hasForgeaX: boolean;
  hasGames: boolean;
}
interface BrowseResp {
  dir: string;
  dirDisplay: string;
  parent: string | null;
  parentDisplay: string | null;
  name: string;
  selfHasForgeaX: boolean;
  selfHasGames: boolean;
  entries: BrowseEntry[];
  error?: string;
}

export interface FsBrowserProps {
  initialDir?: string;
  onPick: (absPath: string, initIfMissing: boolean) => void | Promise<void>;
  onCancel: () => void;
  busy?: boolean;
  externalError?: string | null;
}

export function FsBrowser({ initialDir = '~', onPick, onCancel, busy, externalError }: FsBrowserProps) {
  const { t } = useTranslation();
  const [dir, setDir] = useState(initialDir);
  const [addrInput, setAddrInput] = useState(initialDir);
  const [data, setData] = useState<BrowseResp | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [initIfMissing, setInitIfMissing] = useState(true);

  const load = useCallback(async (target: string) => {
    setLoading(true);
    setLoadErr(null);
    try {
      const r = await fetch(`/api/fs/browse?dir=${encodeURIComponent(target)}`);
      const j = (await r.json()) as BrowseResp;
      if (!r.ok || j.error) {
        setLoadErr(j.error ?? `HTTP ${r.status}`);
        setData(null);
      } else {
        setData(j);
        setAddrInput(j.dirDisplay);
      }
    } catch (e) {
      setLoadErr((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(dir); }, [dir, load]);

  const enter = (name: string) => {
    if (!data) return;
    setDir(`${data.dir.replace(/\/$/, '')}/${name}`);
  };
  const goParent = () => {
    if (data?.parent) setDir(data.parent);
  };
  const goHome = () => setDir('~');
  const goAddr = () => {
    const v = addrInput.trim();
    if (v) setDir(v);
  };

  const onPickClick = () => {
    if (!data) return;
    void onPick(data.dir, initIfMissing);
  };

  return (
    <div className="fsb">
      <div className="fsb-toolbar">
        <button className="fsb-icon-btn" onClick={goParent} disabled={!data?.parent || loading} title={t('fsBrowser.parentDir')}>
          <ArrowUp size={13} />
        </button>
        <button className="fsb-icon-btn" onClick={goHome} disabled={loading} title="HOME">
          <Home size={13} />
        </button>
        <input
          className="fsb-addr"
          value={addrInput}
          onChange={(e) => setAddrInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') goAddr(); }}
          spellCheck={false}
          placeholder="~/path/to/dir"
        />
        <button className="fsb-icon-btn" onClick={goAddr} disabled={loading} title={t('fsBrowser.go')}>
          <FolderOpen size={13} />
        </button>
      </div>

      <div className="fsb-list">
        {loading && (
          <div className="fsb-state"><Loader2 size={14} className="fsb-spin" /> {t('common.loading')}</div>
        )}
        {!loading && loadErr && (
          <div className="fsb-state fsb-err">{loadErr}</div>
        )}
        {!loading && !loadErr && data && data.entries.length === 0 && (
          <div className="fsb-state fsb-dim">{t('fsBrowser.emptyDir')}</div>
        )}
        {!loading && !loadErr && data && data.entries.map((e) => (
          <button
            key={e.name}
            className="fsb-row"
            onClick={() => enter(e.name)}
            title={`${data.dir.replace(/\/$/, '')}/${e.name}`}
          >
            <Folder size={12} className="fsb-row-ico" />
            <span className="fsb-row-name">{e.name}</span>
            <span className="fsb-row-badges">
              {e.hasForgeaX && <span className="fsb-badge">.forgeax</span>}
              {e.hasGames && <span className="fsb-badge fsb-badge-games">games</span>}
            </span>
          </button>
        ))}
      </div>

      <div className="fsb-footer">
        <label className="fsb-check">
          <input
            type="checkbox"
            checked={initIfMissing}
            onChange={(e) => setInitIfMissing(e.target.checked)}
          />
          <span>{t('fsBrowser.initWorkspaceWhenNoGame')}</span>
        </label>
        {externalError && <div className="fsb-ext-err">{externalError}</div>}
        <div className="fsb-actions">
          <button className="tb-modal-btn" onClick={onCancel} disabled={busy}>{t('common.cancel')}</button>
          <button
            className="tb-modal-btn primary"
            onClick={onPickClick}
            disabled={busy || !data}
            title={data ? t('fsBrowser.selectDir', { dir: data.dirDisplay }) : ''}
          >
            {busy ? t('fsBrowser.processing') : t('fsBrowser.selectThisDir')}
          </button>
        </div>
      </div>
    </div>
  );
}
