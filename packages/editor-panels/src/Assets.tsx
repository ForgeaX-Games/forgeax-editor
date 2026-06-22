import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@forgeax/editor-shared/i18n';
import { showContextMenu } from '@forgeax/editor-shared';
import { loadGameAssets, materialSwatch, extractPackDirs, type PackAsset } from '@forgeax/editor-core';
import { dispatch, getSceneId, getSelection, requestRefAsset, requestOpenScene, createSceneFile, setAssetSelection, useAssetSelection, useDocVersion, useSelection, useSceneList, useSceneFile } from '@forgeax/editor-shared';
import { AssetFolderTree } from './AssetFolderTree';
import { AssetCard } from './AssetCard';
import { Breadcrumb } from './Breadcrumb';

type ViewMode = 'list' | 'grid';
type KindFilter = 'all' | 'level' | 'character' | 'material' | 'mesh' | 'texture' | 'scene' | 'animation';

const FILTER_KINDS: KindFilter[] = ['all', 'level', 'material', 'mesh', 'texture'];

export function AssetsPanel() {
  const { t } = useTranslation();
  useDocVersion();
  const sel = useSelection();
  const sceneList = useSceneList();
  const openSceneFile = useSceneFile();

  const assetSel = useAssetSelection();
  const [packs, setPacks] = useState<PackAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDir, setSelectedDir] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const assetScenes = sceneList.filter((s) => s.group === 'asset');
  const levelScenes = sceneList.filter((s) => s.group !== 'asset');

  const packDirs = useMemo(() => extractPackDirs(packs), [packs]);

  const dirAssets = useMemo(() => {
    const base = selectedDir
      ? packs.filter(a => a.packPath.includes(selectedDir + '/'))
      : packs;
    return base.filter(a => a.kind !== 'scene');
  }, [packs, selectedDir]);

  const filtered = useMemo(() => {
    return dirAssets.filter(a => {
      if (kindFilter !== 'all' && a.kind !== kindFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return a.name.toLowerCase().includes(q)
          || a.guid.startsWith(q)
          || a.kind.includes(q);
      }
      return true;
    });
  }, [dirAssets, kindFilter, searchQuery]);

  const newScene = (duplicate: boolean): void => {
    const id = window.prompt(t('editor.assets.newLevelPrompt'));
    if (!id) return;
    void createSceneFile(id, duplicate).then((ok) => {
      if (!ok) window.alert(t('editor.assets.newLevelFailed'));
    });
  };

  const openLevelMenu = (e: { clientX: number; clientY: number; preventDefault: () => void }) => {
    showContextMenu(e, [
      { label: t('editor.assets.menuNewEmptyScene'), onClick: () => newScene(false) },
      { label: t('editor.assets.menuDuplicateScene'), onClick: () => newScene(true) },
    ]);
  };

  const reload = () => {
    setLoading(true);
    const slug = getSceneId();
    void loadGameAssets(slug).then((p) => {
      setPacks(p);
      setLoading(false);
    });
  };

  useEffect(() => {
    reload();
    const onMsg = (ev: MessageEvent) => {
      const d = ev.data as { type?: string } | null;
      if (d?.type === 'VAG_ASSETS_CHANGED') reload();
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openMenu = (a: PackAsset, e: { clientX: number; clientY: number; preventDefault: () => void }) => {
    showContextMenu(e, [
      { label: `${t('editor.assets.menuAssignToSelected')}${sel === null ? ` ${t('editor.assets.menuAssignSelectFirst')}` : ''}`, disabled: sel === null, onClick: () => { if (sel !== null) assign(a.guid); } },
      { label: t('editor.assets.menuRefToChat'), onClick: () => requestRefAsset({ guid: a.guid, kind: a.kind, name: a.name, packPath: a.packPath }) },
      { label: t('editor.assets.menuCopyGuid'), onClick: () => { void navigator.clipboard?.writeText(a.guid); } },
    ]);
  };

  function assign(guid: string): void {
    const id = getSelection();
    if (id === null) return;
    dispatch({ kind: 'setComponent', entity: id, component: 'Material', patch: { materialAsset: guid } });
  }

  function selectAsset(a: PackAsset): void {
    setAssetSelection({ guid: a.guid, kind: a.kind, name: a.name, payload: a.payload, packPath: a.packPath });
  }

  return (
    <div className="panel ed-content-browser" data-testid="panel-assets">
      <h3>
        Content Browser
        <button type="button" className="asset-reload" title={t('editor.assets.reloadTitle')} onClick={reload}>↻</button>
      </h3>

      <div className="cb-layout">
        {/* Left: Source Panel */}
        <div className="cb-source-panel">
          <div className="cb-source-tree">
            <AssetFolderTree dirs={packDirs} selected={selectedDir} onSelect={setSelectedDir} />
          </div>

          <div className="cb-source-scenes">
            {levelScenes.length > 0 && (
              <>
                <div className="asset-group-title" onContextMenu={openLevelMenu}
                  title={t('editor.assets.levelGroupTitleAttr')}>
                  {t('editor.assets.levelGroupTitle')}
                  <button type="button" className="asset-action-btn asset-group-add"
                    title={t('editor.assets.newEmptySceneTitle')}
                    onClick={() => newScene(false)}>＋</button>
                </div>
                {levelScenes.map((s) => {
                  const isOpen = openSceneFile === s.id;
                  return (
                    <div key={s.id} className="asset-row"
                      title={t('editor.assets.levelRowTitle', { pack: s.pack })}
                      onContextMenu={openLevelMenu}
                      onDoubleClick={() => requestOpenScene(s.id)}>
                      <span className="asset-swatch">🗺</span>
                      <span className="asset-name">{s.name ?? s.id}</span>
                      <span className="asset-kind">level</span>
                      {isOpen && <span className="asset-processed-badge" title={t('editor.assets.editingInThisWindow')}>✎</span>}
                    </div>
                  );
                })}
              </>
            )}
            {assetScenes.length > 0 && (
              <>
                <div className="asset-group-title">{t('editor.assets.charMonsterGroupTitle')}</div>
                {assetScenes.map((s) => {
                  const isChar = s.id.startsWith('character:');
                  const isOpen = openSceneFile === s.id;
                  return (
                    <div key={s.id} className="asset-row"
                      title={t('editor.assets.assetRowTitle', { pack: s.pack })}
                      onDoubleClick={() => requestOpenScene(s.id)}>
                      <span className="asset-swatch">{isChar ? '🧍' : '🐮'}</span>
                      <span className="asset-name">{s.name ?? s.id}</span>
                      <span className="asset-kind">{isChar ? 'character' : 'monster'}</span>
                      {isOpen && <span className="asset-processed-badge" title={t('editor.assets.editing')}>✎</span>}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>

        {/* Right: Asset View */}
        <div className="cb-asset-view">
          <Breadcrumb path={selectedDir} onNavigate={setSelectedDir} />

          <div className="cb-toolbar">
            <input className="cb-search" placeholder={t('editor.assets.searchPlaceholder')}
              value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            <div className="cb-filters">
              {FILTER_KINDS.map(k => (
                <button key={k} type="button"
                  className={`cb-filter-btn${kindFilter === k ? ' on' : ''}`}
                  onClick={() => setKindFilter(k)}>
                  {t(`editor.assets.filter.${k}`)}
                </button>
              ))}
              <span className="cb-view-sep" />
              <button type="button" className={`cb-view-btn${viewMode === 'list' ? ' on' : ''}`}
                onClick={() => setViewMode('list')} title="List">≡</button>
              <button type="button" className={`cb-view-btn${viewMode === 'grid' ? ' on' : ''}`}
                onClick={() => setViewMode('grid')} title="Grid">⊞</button>
            </div>
          </div>

          <div className="cb-content">
            {loading ? (
              <div className="muted" style={{ padding: '8px 10px' }}>loading…</div>
            ) : filtered.length === 0 ? (
              <div className="muted" style={{ padding: '8px 10px' }}>
                {packs.length === 0 ? t('editor.assets.emptyPacks') : t('editor.assets.noResults')}
              </div>
            ) : viewMode === 'grid' ? (
              <div className="cb-grid">
                {filtered.map(a => (
                  <AssetCard key={a.guid} asset={a}
                    selected={assetSel?.guid === a.guid}
                    onClick={() => selectAsset(a)}
                    onDoubleClick={() => assign(a.guid)}
                    onContextMenu={(e) => openMenu(a, e)} />
                ))}
              </div>
            ) : (
              <div className="cb-list">
                {filtered.map(a => {
                  const swatch = materialSwatch(a);
                  return (
                    <div key={a.guid} className={`asset-row${assetSel?.guid === a.guid ? ' sel' : ''}`}
                      title={`${a.kind} · ${a.guid}\n${a.packPath}`}
                      onClick={() => selectAsset(a)}
                      onContextMenu={(e) => openMenu(a, e)}
                      onDoubleClick={() => assign(a.guid)}>
                      <span className="asset-swatch" style={swatch ? { background: swatch } : undefined}>
                        {swatch ? '' : a.kind === 'mesh' ? '◫' : a.kind === 'texture' ? '🖼' : '🎨'}
                      </span>
                      <span className="asset-name">{a.name}</span>
                      <span className="asset-kind">{a.kind}</span>
                      <span className="asset-pack-path">{a.packPath.replace(/^.*\//, '')}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
