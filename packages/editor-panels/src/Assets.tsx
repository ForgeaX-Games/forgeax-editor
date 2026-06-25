import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@forgeax/editor-shared/i18n';
import { showContextMenu } from '@forgeax/editor-shared';
import { loadGameAssets, materialSwatch, extractPackDirs, type PackAsset } from '@forgeax/editor-core';
import { dispatch, getSceneId, getSelection, requestRefAsset, requestOpenScene, createSceneFile, setAssetSelection, useAssetSelection, useDocVersion, useSelection, useSceneList, useSceneFile } from '@forgeax/editor-shared';
import { AssetFolderTree } from './AssetFolderTree';
import { AssetCard } from './AssetCard';
import { Breadcrumb } from './Breadcrumb';
import { Component, Suspense, lazy } from 'react';
import type { ReactNode, ErrorInfo } from 'react';

const ContentBrowserV2 = lazy(() =>
  import('./content-browser/ContentBrowserV2').then(m => ({ default: m.ContentBrowserV2 }))
);

class CBErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(e: Error) { return { error: e.message + '\n' + e.stack }; }
  componentDidCatch(e: Error, info: ErrorInfo) { console.error('[ContentBrowserV2]', e, info); }
  render() {
    if (this.state.error) return <div style={{ padding: 12, color: '#f88', whiteSpace: 'pre-wrap', fontSize: 11 }}>Content Browser error:\n{this.state.error}</div>;
    return this.props.children;
  }
}

export function AssetsPanel() {
  return (
    <CBErrorBoundary>
      <Suspense fallback={<div style={{ padding: 16, opacity: 0.5 }}>Loading Content Browser...</div>}>
        <ContentBrowserV2 />
      </Suspense>
    </CBErrorBoundary>
  );
}

type ViewMode = 'list' | 'grid';

const ALL_ASSET_KINDS = [
  'mesh', 'texture', 'cube-texture', 'sampler', 'material', 'scene',
  'shader', 'skeleton', 'skin', 'animation-clip', 'audio', 'font',
  'render-pipeline', 'tileset',
] as const;

type AssetKind = (typeof ALL_ASSET_KINDS)[number];
type KindFilter = 'all' | AssetKind;

const KIND_LABELS: Record<string, string> = {
  all: '⊕ All',
  mesh: '◫ Mesh', texture: '🖼 Texture', 'cube-texture': '🧊 Cube Texture',
  sampler: '⚙ Sampler', material: '🎨 Material', scene: '🗺 Scene',
  shader: '📜 Shader', skeleton: '🦴 Skeleton', skin: '🩻 Skin',
  'animation-clip': '🎬 Animation Clip', audio: '🔊 Audio', font: '🔤 Font',
  'render-pipeline': '🔧 Render Pipeline', tileset: '🧱 Tileset',
};

function _AssetsPanelV1() {
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

  // Levels are scene-kind packs (group 'scene'), which dirAssets deliberately
  // excludes from the catalog grid (scenes open in the viewport, not assign-able
  // like a material). They live in the left LEVELS rail — but a user clicking
  // the "Level" filter expects them in the main view too, so surface them here.
  const levelFiltered = useMemo(() => {
    if (!searchQuery) return levelScenes;
    const q = searchQuery.toLowerCase();
    return levelScenes.filter((s) => (s.name ?? s.id).toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
  }, [levelScenes, searchQuery]);
  const showingLevels = kindFilter === 'level';

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
            {/* Levels moved to the main view's "Level" filter (cb-filters) —
                the redundant left rail was removed. Characters/monsters keep
                their rail here since they have no filter-tab equivalent. */}
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
              <select className="cb-kind-select" value={kindFilter}
                onChange={e => setKindFilter(e.target.value as KindFilter)}>
                <option value="all">{KIND_LABELS.all}</option>
                {ALL_ASSET_KINDS.map(k => (
                  <option key={k} value={k}>{KIND_LABELS[k] ?? k}</option>
                ))}
              </select>
              <span className="cb-view-sep" />
              <button type="button" className={`cb-view-btn${viewMode === 'list' ? ' on' : ''}`}
                onClick={() => setViewMode('list')} title="List">≡</button>
              <button type="button" className={`cb-view-btn${viewMode === 'grid' ? ' on' : ''}`}
                onClick={() => setViewMode('grid')} title="Grid">⊞</button>
            </div>
          </div>

          <div className="cb-content" onClick={(e) => { if (e.target === e.currentTarget) setAssetSelection(null); }}>
            {loading ? (
              <div className="muted" style={{ padding: '8px 10px' }}>loading…</div>
            ) : showingLevels ? (
              levelFiltered.length === 0 ? (
                <div className="muted" style={{ padding: '8px 10px' }}>{t('editor.assets.noResults')}</div>
              ) : (
                <div className="cb-list">
                  {levelFiltered.map((s) => {
                    const isOpen = openSceneFile === s.id;
                    return (
                      <div key={s.id} className={`asset-row${isOpen ? ' sel' : ''}`}
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
                </div>
              )
            ) : filtered.length === 0 ? (
              <div className="muted" style={{ padding: '8px 10px' }}>
                {packs.length === 0 ? t('editor.assets.emptyPacks') : t('editor.assets.noResults')}
              </div>
            ) : viewMode === 'grid' ? (
              <div className="cb-grid" onClick={(e) => { if (e.target === e.currentTarget) setAssetSelection(null); }}>
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
