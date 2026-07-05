// Launcher panel — UE-style play settings as a standalone dockable panel.
//
// Shows what THIS editor window is editing (one window ↔ one scene, bound via
// `?sceneFile=` — see store.switchSceneFile) and configures what the Studio
// ▶ Play tab runs: the full campaign from main, or one specific level.
// Writes the game's play-config.json via writePlayConfig (host-resolved path,
// /api/files; gitignored, per-developer launcher state); the game's main.ts
// reads it at boot.
import { useEffect, useState } from 'react';
import {
  getSceneId, useSceneList, useSceneFile, readPlayConfig, writePlayConfig,
} from '@forgeax/editor-core';
import { useTranslation } from '@forgeax/editor-core/i18n';

const CAMPAIGN = '__campaign__';

export function LauncherPanel() {
  const { t } = useTranslation();
  const scenes = useSceneList();
  const current = useSceneFile();
  const [value, setValue] = useState<string>(CAMPAIGN);
  const [savedAt, setSavedAt] = useState<number>(0);
  const levels = scenes;
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
      .then((ok) => {
        if (!ok) return;
        setSavedAt(Date.now());
        // Switch the running ▶ Play to the picked level LIVE — post VAG_SET_LEVEL
        // so the game switches in place (unloadLevel+loadLevel) instead of
        // reloading the Play iframe (a reload re-creates the WebGPU context, which
        // wedges WKWebView's GPU process). CAMPAIGN → first level. Multi-level
        // games handle it; single-scene games ignore it (no-op). PlaySurface lives
        // in the Studio shell (top window) and forwards it to the game iframe.
        const level = v === CAMPAIGN ? (levels[0]?.id ?? '') : v;
        if (level) {
          try { window.top?.postMessage({ type: 'VAG_SET_LEVEL', level }, '*'); } catch { /* cross-origin */ }
        }
      });
  };

  return (
    <div className="panel ed-launcher" data-testid="panel-launcher">
      <h3>{t('editor.launcher.title')}</h3>

      <div className="launcher-section">
        <div className="launcher-label">{t('editor.launcher.editingInThisWindow')}</div>
        <div className="launcher-current" title={t('editor.launcher.editingHint')}>
          {currentEntry
            ? `🗺 ${currentEntry.name ?? currentEntry.id}`
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
