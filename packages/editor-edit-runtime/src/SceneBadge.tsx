// SceneBadge — read-only indicator of what THIS editor window is editing.
//
// One editor window ↔ one scene (UE model; binding carried by `?sceneFile=`).
// Switching what a window edits happens by double-clicking a level / asset in
// the Assets panel — never from a toolbar dropdown. Play settings live in the
// standalone 启动器 panel.
import { getSceneId, useSceneFile, useSceneList } from '@forgeax/editor-shared';

export function SceneBadge() {
  const scenes = useSceneList();
  const current = useSceneFile();
  if (getSceneId() === 'default') return null;
  const entry = scenes.find((s) => s.id === current);
  const label = entry
    ? `${entry.group === 'asset' ? '✎' : '🗺'} ${entry.name ?? entry.id}`
    : '🗺 主场景';
  return (
    <span className="vp-scene-badge" data-testid="vp-scene-badge"
      title="本窗口编辑的关卡/资产 — 在 Assets 面板双击其它条目可切换">
      {label}
    </span>
  );
}
