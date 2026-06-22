// Launcher panel — UE-style play settings as a standalone dockable panel.
//
// Shows what THIS editor window is editing (one window ↔ one scene, bound via
// `?sceneFile=` — see store.switchSceneFile) and configures what the Studio
// ▶ Play tab runs: the full campaign from main, or one specific level.
// Writes .forgeax/games/<slug>/play-config.json via /api/files (gitignored,
// per-developer launcher state); the game's main.ts reads it at boot.
import { useEffect, useState } from 'react';
import {
  getSceneId, useSceneList, useSceneFile, readPlayConfig, writePlayConfig,
} from '@forgeax/editor-shared';
import { useTranslation } from '@forgeax/editor-shared/i18n';

const CAMPAIGN = '__campaign__';

export function LauncherPanel() {
  const { t } = useTranslation();
  const scenes = useSceneList();
  const current = useSceneFile();
  const [value, setValue] = useState<string>(CAMPAIGN);
  const [savedAt, setSavedAt] = useState<number>(0);
  const levels = scenes.filter((s) => s.group !== 'asset');
  const currentEntry = scenes.find((s) => s.id === current);

  useEffect(() => {
    void readPlayConfig().then((cfg) => {
      setValue(cfg.mode === 'level' && cfg.level ? cfg.level : CAMPAIGN);
    });
  }, []);

  if (getSceneId() === 'default') {
    return <div className="panel ed-launcher"><h3>{t('editor.launcher.title')}</h3><div className="muted" style={{ padding: '4px 10px' }}>{t('editor.launcher.noGameOpen')}</div></div>;
  }

  const pick = (v: string): void => {
    setValue(v);
    void writePlayConfig(v === CAMPAIGN ? { mode: 'campaign' } : { mode: 'level', level: v })
      .then((ok) => { if (ok) setSavedAt(Date.now()); });
  };

  return (
    <div className="panel ed-launcher" data-testid="panel-launcher">
      <h3>{t('editor.launcher.title')}</h3>

      <div className="launcher-section">
        <div className="launcher-label">{t('editor.launcher.editingInThisWindow')}</div>
        <div className="launcher-current" title={t('editor.launcher.editingHint')}>
          {currentEntry
            ? `${currentEntry.group === 'asset' ? '✎' : '🗺'} ${currentEntry.name ?? currentEntry.id}`
            : t('editor.launcher.mainScene')}
        </div>
      </div>

      <div className="launcher-section">
        <div className="launcher-label">{t('editor.launcher.playRun')}</div>
        <label className="launcher-option">
          <input type="radio" name="play-target" checked={value === CAMPAIGN} onChange={() => pick(CAMPAIGN)} />
          <span>{t('editor.launcher.campaignOption')}</span>
        </label>
        {levels.map((s) => (
          <label key={s.id} className="launcher-option">
            <input type="radio" name="play-target" checked={value === s.id} onChange={() => pick(s.id)} />
            <span>{t('editor.launcher.levelOnly', { name: s.name ?? s.id })}</span>
          </label>
        ))}
      </div>

      <div className="muted launcher-hint">
        {t('editor.launcher.configHint')}
        {savedAt > 0 && <span className="launcher-saved"> {t('editor.launcher.saved')}</span>}
      </div>
    </div>
  );
}
