// SceneBadge — read-only indicator of what THIS editor window is editing.
//
// One editor window ↔ one scene (UE model; binding lives in localStorage +
// in-memory ctx). Switching what a window edits happens by double-clicking a
// level / asset in the Assets panel — never from a toolbar dropdown. Play
// settings live in the standalone 启动器 panel.
import { useSceneReadModel } from '@forgeax/editor-core';
import { useTranslation } from '@forgeax/editor-core/i18n';

export function SceneBadge() {
  const { t } = useTranslation();
  const sceneModel = useSceneReadModel();
  if (sceneModel.gameId === null) return null;
  const entry = sceneModel.scenes.find((s) => s.isCurrent);
  const label = entry
    ? `🗺 ${entry.name ?? entry.id}`
    : `🗺 ${t('editor.sceneBadge.mainScene')}`;
  return (
    <span className="vp-scene-badge" data-testid="vp-scene-badge"
      title={t('editor.sceneBadge.title')}>
      {label}
    </span>
  );
}
