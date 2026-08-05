// SaveAssetsDialog — UE 风格「保存内容」审阅弹窗。
// 列出当前场景（若有未保存改动）与会话内已修改的资产，以多列表格 +
// 逐行复选框 + 全选呈现。「保存选中项」对场景行派发 saveDocToDisk，
// 对选中的资产行从会话脏集清除（资产编辑已即时落盘，此处为检查点）。
//
// 外壳沿用 DeleteGuardDialog 的 cb-dialog-overlay / cb-dialog 体系，
// 但按 UE 美学重做头部、表格与底栏：头部带图标与标题、右上角关闭按钮；
// 表格行支持悬停高亮；主操作为强调色按钮。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@forgeax/editor-ui';
import {
  gateway,
  usePendingDiskSave,
  useSceneReadModel,
  useSessionDirtyAssets,
  clearSessionDirtyAssets,
} from '@forgeax/editor-core';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { ContentBrowserIcon, iconNameForAssetKind } from './content-browser-icons';

const SCENE_ROW_ID = '__scene__';
const DIALOG_KEY = 'editor.contentBrowser.dialogs.saveAllDialog';

/** 去掉 pack 文件名噪音，仅保留可读的相对路径。 */
function prettifyPackPath(packPath: string): string {
  if (!packPath) return '';
  let p = packPath.replace(/\.pack\.json$/i, '');
  p = p.replace(/^\.?\/+/, '');
  return p;
}

export interface SaveAssetsDialogProps {
  /** 用户确认时传 true，取消时传 false。 */
  onClose: (confirmed: boolean) => void;
}

interface Row {
  readonly id: string;
  readonly name: string;
  readonly packPath: string;
  readonly kindLabel: string;
  readonly iconName: string;
  readonly isScene: boolean;
}

/**
 * 构造表格行：当前场景（脏时）+ 会话脏资产。
 * 场景脏状态通过 usePendingDiskSave 响应式订阅，避免只读 session 脏集时漏掉场景行。
 */
function useRows(): readonly Row[] {
  const { t } = useTranslation();
  const sceneDirty = usePendingDiskSave();
  const sceneModel = useSceneReadModel();
  const dirtyAssets = useSessionDirtyAssets();
  return useMemo(() => {
    const rows: Row[] = [];
    if (sceneDirty) {
      const current = sceneModel.scenes.find((s) => s.isCurrent) ?? null;
      rows.push({
        id: SCENE_ROW_ID,
        name: current?.name ?? sceneModel.currentScene?.id ?? t(`${DIALOG_KEY}.untitledScene`),
        packPath: prettifyPackPath(current?.pack ?? ''),
        kindLabel: t(`${DIALOG_KEY}.assetKinds.scene`),
        iconName: 'clapperboard',
        isScene: true,
      });
    }
    for (const asset of dirtyAssets) {
      let kind = asset.kind;
      let name = asset.name;
      if (kind === undefined || name === undefined) {
        const summary = gateway.describeAssetByGuid(asset.guid);
        if (summary.ok) {
          if (kind === undefined) kind = summary.kind;
          if (name === undefined) name = summary.name ?? asset.guid;
        }
      }
      const resolvedKind = kind ?? '';
      const kindKey = `${DIALOG_KEY}.assetKinds.${resolvedKind || 'default'}`;
      const kindLabel = t(kindKey);
      rows.push({
        id: asset.guid,
        name: name ?? asset.guid,
        packPath: prettifyPackPath(asset.packPath ?? ''),
        kindLabel: kindLabel === kindKey
          ? (resolvedKind || t(`${DIALOG_KEY}.assetKinds.default`))
          : kindLabel,
        iconName: iconNameForAssetKind(resolvedKind),
        isScene: false,
      });
    }
    return rows;
  }, [sceneDirty, sceneModel, dirtyAssets, t]);
}

export function SaveAssetsDialog({ onClose }: SaveAssetsDialogProps) {
  const { t } = useTranslation();
  const rows = useRows();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(rows.map((r) => r.id)));
  const saveRef = useRef<HTMLButtonElement>(null);

  // 行集合变化时同步选择：保留先前取消项，新增行默认选中，移除已不存在的行。
  useEffect(() => {
    setSelected((prev) => {
      const currentIds = new Set(rows.map((r) => r.id));
      const next = new Set<string>();
      for (const id of prev) if (currentIds.has(id)) next.add(id);
      for (const row of rows) if (!prev.has(row.id)) next.add(row.id);
      return next;
    });
  }, [rows]);

  useEffect(() => { saveRef.current?.focus(); }, []);

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const noneSelected = selected.size === 0;

  function toggleRow(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll(): void {
    setSelected((prev) => {
      if (rows.length > 0 && prev.size === rows.length) return new Set();
      return new Set(rows.map((r) => r.id));
    });
  }

  function handleSave(): void {
    if (selected.has(SCENE_ROW_ID)) {
      gateway.dispatch({ kind: 'saveDocToDisk', requestId: crypto.randomUUID() }, 'human');
    }
    const assetGuids = rows.filter((r) => !r.isScene && selected.has(r.id)).map((r) => r.id);
    clearSessionDirtyAssets(assetGuids);
    onClose(true);
  }

  function handleCancel(): void {
    onClose(false);
  }

  return (
    <div className="cb-dialog-overlay" data-testid="cb-save-all-overlay" onClick={handleCancel}>
      <div
        className="cb-dialog cb-dialog-wide cb-dialog-ue"
        role="dialog"
        aria-modal="true"
        aria-label={t(`${DIALOG_KEY}.title`)}
        data-testid="cb-save-all-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); handleCancel(); }
        }}
        tabIndex={-1}
      >
        <div className="cb-dialog-header">
          <span className="cb-dialog-header-icon">
            <ContentBrowserIcon name="save" />
          </span>
          <span className="cb-dialog-header-title">{t(`${DIALOG_KEY}.title`)}</span>
          <button
            type="button"
            className="cb-dialog-close"
            aria-label={t(`${DIALOG_KEY}.cancel`)}
            data-testid="cb-save-all-close"
            onClick={handleCancel}
          >
            ✕
          </button>
        </div>

        <div className="cb-dialog-body">
          <p className="cb-dialog-note">{t(`${DIALOG_KEY}.body`)}</p>
          {rows.length === 0 ? (
            <p className="cb-dialog-empty" data-testid="cb-save-all-empty">
              {t(`${DIALOG_KEY}.nothingToSave`)}
            </p>
          ) : (
            <div className="cb-dialog-table-scroll">
              <table className="cb-dialog-table">
                <thead>
                  <tr className="cb-dialog-thead">
                    <th className="cb-dialog-th cb-dialog-th-check">
                      <input
                        type="checkbox"
                        aria-label={t(`${DIALOG_KEY}.selectAll`)}
                        checked={allSelected}
                        onChange={toggleAll}
                        data-testid="cb-save-all-select-all"
                      />
                    </th>
                    <th className="cb-dialog-th cb-dialog-th-asset">{t(`${DIALOG_KEY}.colAsset`)}</th>
                    <th className="cb-dialog-th cb-dialog-th-file">{t(`${DIALOG_KEY}.colFile`)}</th>
                    <th className="cb-dialog-th cb-dialog-th-type">{t(`${DIALOG_KEY}.colType`)}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="cb-dialog-row" data-testid="cb-save-all-row">
                      <td className="cb-dialog-td cb-dialog-td-check">
                        <input
                          type="checkbox"
                          aria-label={row.name}
                          checked={selected.has(row.id)}
                          onChange={() => toggleRow(row.id)}
                          data-testid={`cb-save-all-check-${row.id}`}
                        />
                      </td>
                      <td className="cb-dialog-td cb-dialog-td-asset">
                        <span className="cb-dialog-icon">
                          <ContentBrowserIcon name={row.iconName} />
                        </span>
                        <span className="cb-dialog-asset-name">{row.name}</span>
                      </td>
                      <td className="cb-dialog-td cb-dialog-td-file">{row.packPath || '—'}</td>
                      <td className="cb-dialog-td cb-dialog-td-type">{row.kindLabel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="cb-dialog-actions">
          <Button
            className="cb-dialog-btn"
            data-testid="cb-save-all-cancel"
            size="sm"
            variant="subtle"
            onClick={handleCancel}
          >
            {t(`${DIALOG_KEY}.cancel`)}
          </Button>
          <Button
            ref={saveRef}
            className="cb-dialog-btn cb-dialog-btn-primary"
            data-testid="cb-save-all-confirm"
            size="sm"
            variant="default"
            disabled={noneSelected}
            onClick={handleSave}
          >
            {t(`${DIALOG_KEY}.saveSelected`)}
          </Button>
        </div>
      </div>
    </div>
  );
}
