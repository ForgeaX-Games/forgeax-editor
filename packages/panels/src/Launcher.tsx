// Launcher panel — UE-style play settings as a standalone dockable panel.
//
// Shows what THIS editor window is editing (one window ↔ one scene, bound via
// localStorage + in-memory ctx) and configures what the Studio
// ▶ Play tab runs: the full campaign from main, or one specific SceneAsset.
// Writes host-owned launcher state via writePlayConfig; the play host consumes
// its selected GUID before bootstrap, while the game owns campaign semantics.
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
      setValue(cfg.mode === 'level' && cfg.sceneGuid ? cfg.sceneGuid : CAMPAIGN);
    });
  }, []);

  if (getSceneId() === 'default') {
    return <div className="panel ed-launcher"><h3>{t('editor.launcher.title')}</h3><div className="muted" style={{ padding: '4px 10px' }}>{t('editor.launcher.noGameOpen')}</div></div>;
  }

  const pick = (sceneGuid: string): void => {
    setValue(sceneGuid);
    void writePlayConfig(
      sceneGuid === CAMPAIGN ? { mode: 'campaign' } : { mode: 'level', sceneGuid },
    ).then((ok) => {
      if (!ok) return;
      setSavedAt(Date.now());
      // Live switching preserves the running WebGPU context. The game receives
      // only the selected SceneAsset GUID and decides whether it is meaningful.
      const selectedGuid = sceneGuid === CAMPAIGN ? levels[0]?.guid : sceneGuid;
      if (selectedGuid) {
        try { window.top?.postMessage({ type: 'VAG_SET_LEVEL', sceneGuid: selectedGuid }, '*'); } catch { /* cross-origin */ }
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
        {levels.filter((scene) => scene.guid !== undefined).map((scene) => (
          <label key={scene.guid} className="launcher-option">
            <input
              type="radio"
              name="play-target"
              checked={value === scene.guid}
              onChange={() => pick(scene.guid!)}
            />
            <span>{t('editor.launcher.levelOnly', { name: scene.name ?? scene.id })}</span>
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
