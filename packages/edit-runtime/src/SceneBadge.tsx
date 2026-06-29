// SceneBadge — read-only indicator of what THIS editor window is editing.
//
// One editor window ↔ one scene (UE model; binding carried by `?sceneFile=`).
// Switching what a window edits happens by double-clicking a level / asset in
// the Assets panel — never from a toolbar dropdown. Play settings live in the
// standalone 启动器 panel.
import { getSceneId, useSceneFile, useSceneList } from '@forgeax/editor-shared';
import { useTranslation } from '@forgeax/editor-shared/i18n';

export function SceneBadge() {
  const { t } = useTranslation();
  const scenes = useSceneList();
  const current = useSceneFile();
  if (getSceneId() === 'default') return null;
  const entry = scenes.find((s) => s.id === current);
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
