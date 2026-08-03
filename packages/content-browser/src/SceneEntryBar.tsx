// SceneEntryBar — the visible human projection of the scene lifecycle front door.
//
// The scene read model and OperationRun registry are both Gateway-owned. This
// control bar only reads those projections and dispatches the same scene ops a
// docs-only AI caller uses: createSceneFile, switchSceneFile, setDefaultScene,
// and deleteScene. It intentionally does not maintain a second scene identity
// or call persistence/asset IO directly.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  gateway,
  useSceneReadModel,
  type SceneReadModel,
  type SceneReadModelEntry,
} from '@forgeax/editor-core';
import { prompt as promptDialog } from '@forgeax/editor-ui';
import { useTranslation } from '@forgeax/editor-core/i18n';

const SCENE_OPERATION_IDS = new Set(['createSceneFile', 'setDefaultScene', 'deleteScene']);

function subscribeOperationRuns(listener: () => void): () => void {
  return gateway.subscribeOperationRuns(() => listener());
}

function getOperationRevision(): number {
  return gateway.operationRunSnapshot().revision;
}

function currentEntry(model: SceneReadModel): SceneReadModelEntry | undefined {
  return model.scenes.find((entry) => entry.isCurrent)
    ?? model.scenes.find((entry) => entry.id === model.currentScene?.id);
}

function sceneLabel(entry: SceneReadModelEntry): string {
  const markers = [entry.isCurrent ? 'current' : '', entry.isDefault ? 'default' : ''].filter(Boolean);
  return markers.length === 0 ? entry.name : `${entry.name} (${markers.join(', ')})`;
}

function operationLabel(operationId: string): string {
  switch (operationId) {
    case 'createSceneFile': return 'Create scene';
    case 'setDefaultScene': return 'Set default';
    case 'deleteScene': return 'Delete scene';
    default: return operationId;
  }
}

export function SceneEntryBar(): ReactNode {
  const { t } = useTranslation();
  const sceneModel = useSceneReadModel();
  useSyncExternalStore(subscribeOperationRuns, getOperationRevision, getOperationRevision);
  const [selectedId, setSelectedId] = useState('');
  const [pendingSwitchId, setPendingSwitchId] = useState<string | null>(null);
  const [dispatchError, setDispatchError] = useState<{ code: string; hint: string } | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);

  const current = currentEntry(sceneModel);
  const selected = sceneModel.scenes.find((entry) => entry.id === selectedId) ?? current;
  const operationSnapshot = gateway.operationRunSnapshot();
  const latestRun = activeRequestId === null
    ? [...operationSnapshot.runs]
      .filter((run) => SCENE_OPERATION_IDS.has(run.operationId))
      .sort((a, b) => b.sequence - a.sequence)[0]
    : operationSnapshot.runs.find((run) => run.requestId === activeRequestId);

  useEffect(() => {
    if (current !== undefined) setSelectedId(current.id);
  }, [current?.id]);

  const dispatchErrorText = dispatchError === null ? null : `${dispatchError.code}: ${dispatchError.hint}`;
  const runText = latestRun === undefined
    ? null
    : `${operationLabel(latestRun.operationId)}: ${latestRun.status}${latestRun.error ? ` — ${latestRun.error.code}: ${latestRun.error.hint}` : ''}`;
  const statusText = dispatchErrorText ?? runText ?? t('editor.sceneEntry.ready');
  const statusPhase = dispatchError !== null
    ? 'failed'
    : latestRun?.status ?? 'ready';

  const recordError = (result: { ok: false; error: { code: string; hint: string } }): void => {
    setDispatchError({ code: result.error.code, hint: result.error.hint });
  };

  const recordAcceptedRun = (result: { ok: true; result?: { operationRun?: { requestId?: string } } }): void => {
    const requestId = result.result?.operationRun?.requestId;
    if (requestId !== undefined) setActiveRequestId(requestId);
  };

  const dispatchCreate = async (duplicateCurrent: boolean): Promise<void> => {
    const defaultValue = duplicateCurrent
      ? `${selected?.name ?? current?.name ?? 'Scene'}-copy`
      : 'NewScene';
    const id = (await promptDialog({
      title: duplicateCurrent ? t('editor.sceneEntry.duplicateTitle') : t('editor.sceneEntry.createTitle'),
      label: t('editor.sceneEntry.nameLabel'),
      defaultValue,
      confirmText: t('editor.contentBrowser.dialogs.createConfirm'),
      cancelText: t('editor.contentBrowser.dialogs.cancel'),
    }))?.trim();
    if (!id) return;
    setDispatchError(null);
    const requestId = crypto.randomUUID();
    const result = gateway.dispatch({ kind: 'createSceneFile', id, duplicateCurrent, requestId }, 'human');
    if (!result.ok) recordError(result);
    else recordAcceptedRun(result);
  };

  const switchScene = (id: string, dirtyPolicy?: 'save' | 'discard'): void => {
    setDispatchError(null);
    const result = gateway.dispatch(
      dirtyPolicy === undefined
        ? { kind: 'switchSceneFile', id, requestId: crypto.randomUUID() }
        : { kind: 'switchSceneFile', id, dirtyPolicy, requestId: crypto.randomUUID() },
      'human',
    );
    if (!result.ok) {
      if (result.error.code === 'scene-switch-dirty' && dirtyPolicy === undefined) {
        setPendingSwitchId(id);
      }
      recordError(result);
      return;
    }
    recordAcceptedRun(result);
    setPendingSwitchId(null);
    setSelectedId(id);
  };

  const dispatchSceneRequest = (kind: 'setDefaultScene' | 'deleteScene'): void => {
    if (selected?.guid === null || selected?.guid === undefined) {
      setDispatchError({ code: 'scene-guid-unavailable', hint: t('editor.sceneEntry.guidUnavailable') });
      return;
    }
    setDispatchError(null);
    const requestId = crypto.randomUUID();
    const result = gateway.dispatch(
      kind === 'setDefaultScene'
        ? { kind, sceneGuid: selected.guid, requestId }
        : { kind, sceneGuid: selected.guid, requestId },
      'human',
    );
    if (!result.ok) recordError(result);
    else recordAcceptedRun(result);
  };

  return (
    <section className="cb-scene-entry" data-testid="scene-entry-bar" data-facts="product" data-projection-source="editor-product">
      <div className="cb-scene-entry-head">
        <span className="cb-scene-entry-title">{t('editor.sceneEntry.title')}</span>
        <span className="cb-scene-entry-badge" data-testid="scene-entry-current">
          {current?.name ?? t('editor.sceneEntry.noScene')}
        </span>
      </div>
      <div className="cb-scene-entry-controls">
        <label className="cb-scene-entry-select-label" htmlFor="scene-entry-select">{t('editor.sceneEntry.selectLabel')}</label>
        <select
          id="scene-entry-select"
          className="cb-scene-entry-select"
          data-testid="scene-entry-select"
          aria-label={t('editor.sceneEntry.selectLabel')}
          value={current?.id ?? ''}
          disabled={sceneModel.scenes.length === 0}
          onChange={(event) => switchScene(event.target.value)}
        >
          {sceneModel.scenes.length === 0 && <option value="">{t('editor.sceneEntry.noScene')}</option>}
          {sceneModel.scenes.map((entry) => (
            <option key={entry.id} value={entry.id}>{sceneLabel(entry)}</option>
          ))}
        </select>
        <label className="cb-scene-entry-select-label" htmlFor="scene-entry-target">{t('editor.sceneEntry.targetLabel')}</label>
        <select
          id="scene-entry-target"
          className="cb-scene-entry-select"
          data-testid="scene-entry-target"
          aria-label={t('editor.sceneEntry.targetLabel')}
          value={selected?.id ?? ''}
          disabled={sceneModel.scenes.length === 0}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {sceneModel.scenes.length === 0 && <option value="">{t('editor.sceneEntry.noScene')}</option>}
          {sceneModel.scenes.map((entry) => (
            <option key={entry.id} value={entry.id}>{sceneLabel(entry)}</option>
          ))}
        </select>
        <button type="button" className="cb-scene-entry-btn" data-testid="scene-entry-create" onClick={() => void dispatchCreate(false)}>
          {t('editor.sceneEntry.create')}
        </button>
        <button type="button" className="cb-scene-entry-btn" data-testid="scene-entry-duplicate" disabled={current === undefined} onClick={() => void dispatchCreate(true)}>
          {t('editor.sceneEntry.duplicate')}
        </button>
        <button type="button" className="cb-scene-entry-btn" data-testid="scene-entry-default" disabled={selected?.guid === null || selected?.guid === undefined || selected.isDefault} onClick={() => dispatchSceneRequest('setDefaultScene')}>
          {t('editor.sceneEntry.setDefault')}
        </button>
        <button type="button" className="cb-scene-entry-btn cb-scene-entry-btn-danger" data-testid="scene-entry-delete" disabled={selected?.guid === null || selected?.guid === undefined} onClick={() => dispatchSceneRequest('deleteScene')}>
          {t('editor.sceneEntry.delete')}
        </button>
      </div>
      {pendingSwitchId !== null && (
        <div className="cb-scene-entry-policy" data-testid="scene-entry-switch-policy">
          <span>{t('editor.contentBrowser.dialogs.sceneSwitch.body', { name: pendingSwitchId })}</span>
          <button type="button" onClick={() => switchScene(pendingSwitchId, 'save')}>{t('editor.contentBrowser.dialogs.sceneSwitch.save')}</button>
          <button type="button" onClick={() => switchScene(pendingSwitchId, 'discard')}>{t('editor.contentBrowser.dialogs.sceneSwitch.discard')}</button>
          <button type="button" onClick={() => { setPendingSwitchId(null); setDispatchError(null); }}>{t('editor.contentBrowser.dialogs.sceneSwitch.cancel')}</button>
        </div>
      )}
      <output className={`cb-scene-entry-status is-${statusPhase}`} data-testid="scene-entry-status" data-phase={statusPhase} aria-live="polite">
        {statusText}
      </output>
    </section>
  );
}
