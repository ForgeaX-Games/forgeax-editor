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

const CAMPAIGN = '__campaign__';

export function LauncherPanel() {
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
    return <div className="panel ed-launcher"><h3>启动器</h3><div className="muted" style={{ padding: '4px 10px' }}>未打开游戏。</div></div>;
  }

  const pick = (v: string): void => {
    setValue(v);
    void writePlayConfig(v === CAMPAIGN ? { mode: 'campaign' } : { mode: 'level', level: v })
      .then((ok) => { if (ok) setSavedAt(Date.now()); });
  };

  return (
    <div className="panel ed-launcher" data-testid="panel-launcher">
      <h3>启动器</h3>

      <div className="launcher-section">
        <div className="launcher-label">本窗口正在编辑</div>
        <div className="launcher-current" title="从 Assets 面板双击其它关卡/资产可切换（或在新窗口打开）">
          {currentEntry
            ? `${currentEntry.group === 'asset' ? '✎' : '🗺'} ${currentEntry.name ?? currentEntry.id}`
            : '主场景'}
        </div>
      </div>

      <div className="launcher-section">
        <div className="launcher-label">▶ Play 运行</div>
        <label className="launcher-option">
          <input type="radio" name="play-target" checked={value === CAMPAIGN} onChange={() => pick(CAMPAIGN)} />
          <span>全局 (main) — 完整战役，从第 1 关开始</span>
        </label>
        {levels.map((s) => (
          <label key={s.id} className="launcher-option">
            <input type="radio" name="play-target" checked={value === s.id} onChange={() => pick(s.id)} />
            <span>仅 {s.name ?? s.id}</span>
          </label>
        ))}
      </div>

      <div className="muted launcher-hint">
        写入 play-config.json（本地启动器状态，不进版本库）；▶ Play 启动时读取。
        {savedAt > 0 && <span className="launcher-saved"> ✓ 已保存</span>}
      </div>
    </div>
  );
}
