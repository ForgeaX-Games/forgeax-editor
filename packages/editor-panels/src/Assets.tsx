import { useEffect, useState } from 'react';
import { useTranslation } from '@forgeax/editor-shared/i18n';
import { showContextMenu } from '@forgeax/editor-shared';
import { loadGameAssets, loadRawAssets, materialSwatch, type PackAsset, type RawAsset } from '@forgeax/editor-core';
import { bus, dispatch, getSceneId, getSelection, requestRefAsset, requestOpenScene, createSceneFile, useDocVersion, useSelection, useSceneList, useSceneFile } from '@forgeax/editor-shared';

// Assets panel — the content browser (UE habit): levels AND character/monster
// packs are assets here; double-click opens them in the editor (one window ↔
// one scene; the binding rides `?sceneFile=`). Right-click a level for
// new/duplicate. Below them: *.pack.json sub-assets (materials, meshes) and
// raw imported files (GLB/PNG/audio) with process/import actions.

interface Menu { guid: string; x: number; y: number }
type Tab = 'packs' | 'files';

const KIND_ICON: Record<string, string> = {
  'raw-model': '📦', 'raw-image': '🖼', 'raw-audio': '🔊', 'raw-other': '📄',
};

async function processGltf(path: string): Promise<{ ok: boolean; error?: string; total?: number }> {
  try {
    const r = await fetch('/api/assets/process-gltf', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const j = await r.json() as { ok?: boolean; error?: string; total?: number };
    return r.ok ? { ok: true, total: j.total } : { ok: false, error: j.error };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

type SceneDoc = { version: string; nextId: number; entities: Record<number, unknown>; order: number[] };
async function importScene(path: string, mode: 'reference' | 'full' | 'auto' = 'auto'): Promise<
  { ok: true; mode: string; totalNodes: number; meshCount: number; doc?: SceneDoc; entity?: unknown; warning?: string } |
  { ok: false; error: string }
> {
  try {
    const r = await fetch('/api/assets/import-scene', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, mode }),
    });
    const j = await r.json() as { mode?: string; totalNodes?: number; meshCount?: number; doc?: SceneDoc; entity?: unknown; warning?: string; error?: string };
    if (!r.ok) return { ok: false, error: j.error ?? `HTTP ${r.status}` };
    return { ok: true, mode: j.mode ?? 'reference', totalNodes: j.totalNodes ?? 0, meshCount: j.meshCount ?? 0, doc: j.doc, entity: j.entity, warning: j.warning };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export function AssetsPanel() {
  const { t } = useTranslation();
  useDocVersion();
  const sel = useSelection();
  const sceneList = useSceneList();
  const openSceneFile = useSceneFile();
  const [tab, setTab] = useState<Tab>('packs');
  const [packs, setPacks] = useState<PackAsset[]>([]);
  const [rawFiles, setRawFiles] = useState<RawAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  // Editable scene/prefab packs discovered by initSceneList — levels (the UE
  // "level asset") + monsters/characters. Double-click opens; ✎ marks what
  // THIS window is editing.
  const assetScenes = sceneList.filter((s) => s.group === 'asset');
  const levelScenes = sceneList.filter((s) => s.group !== 'asset');

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
    void Promise.all([loadGameAssets(slug), loadRawAssets(slug)]).then(([p, r]) => {
      setPacks(p); setRawFiles(r); setLoading(false);
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

  // Right-click menu → shared service (renders at the top layer of the whole
  // window / posts to the interface parent; never clipped by this panel).
  const openMenu = (a: PackAsset, e: { clientX: number; clientY: number; preventDefault: () => void }) => {
    showContextMenu(e, [
      { label: `${t('editor.assets.menuAssignToSelected')}${sel === null ? t('editor.assets.menuAssignSelectFirst') : ''}`, disabled: sel === null, onClick: () => { if (sel !== null) assign(a.guid); } },
      { label: t('editor.assets.menuRefToChat'), onClick: () => requestRefAsset({ guid: a.guid, kind: a.kind, name: a.name, packPath: a.packPath }) },
      { label: t('editor.assets.menuCopyGuid'), onClick: () => { void navigator.clipboard?.writeText(a.guid); } },
    ]);
  };

  function assign(guid: string): void {
    const id = getSelection();
    if (id === null) return;
    dispatch({ kind: 'setComponent', entity: id, component: 'Material', patch: { materialAsset: guid } });
  }

  const handleProcess = async (raw: RawAsset) => {
    setProcessing((s) => new Set([...s, raw.path]));
    const res = await processGltf(raw.path);
    setProcessing((s) => { const n = new Set(s); n.delete(raw.path); return n; });
    if (!res.ok) { alert(t('editor.assets.processFailed', { error: res.error })); return; }
    alert(t('editor.assets.processDone', { total: res.total }));
    reload();
  };

  const handleAddToScene = async (raw: RawAsset) => {
    const res = await importScene(raw.path, 'auto');
    if (!res.ok) { alert(t('editor.assets.importSceneFailed', { error: res.error })); return; }
    if (res.warning) {
      const proceed = confirm(t('editor.assets.importSceneWarning', { warning: res.warning }));
      if (!proceed) return;
    }
    if (res.mode === 'reference' && res.entity) {
      // Single GltfRef entity — recommended for large scenes.
      const e = res.entity as { name: string; components: Record<string, unknown> };
      bus.dispatch({ kind: 'spawnEntity', name: e.name, components: e.components });
      alert(t('editor.assets.importRefDone', { name: e.name, totalNodes: res.totalNodes, meshCount: res.meshCount }));
    } else if (res.mode === 'full' && res.doc) {
      // Full import: dispatch all entities as a transaction.
      const doc = res.doc;
      const cmds = doc.order.map((id) => {
        const ent = doc.entities[id] as { name: string; parent: number | null; components: Record<string, unknown> };
        return { kind: 'spawnEntity' as const, name: ent.name, parent: ent.parent ?? undefined, components: ent.components };
      });
      bus.dispatch({ kind: 'transaction', label: `Import GLB: ${raw.name}`, commands: cmds });
      alert(t('editor.assets.importFullDone', { totalNodes: res.totalNodes }));
    }
  };

  return (
    <div className="panel ed-assets" data-testid="panel-assets">
      <h3>Assets</h3>
      <div className="asset-tabs">
        <button type="button" className={`asset-tab${tab === 'packs' ? ' on' : ''}`} onClick={() => setTab('packs')}>Packs</button>
        <button type="button" className={`asset-tab${tab === 'files' ? ' on' : ''}`} onClick={() => setTab('files')}>Files</button>
        <button type="button" className="asset-reload" title={t('editor.assets.reloadTitle')} onClick={reload}>↻</button>
      </div>

      {tab === 'packs' && (
        <div className="asset-list" data-testid="asset-list">
          {levelScenes.length > 0 && (
            <>
              <div className="asset-group-title" onContextMenu={openLevelMenu}
                title={t('editor.assets.levelGroupTitleAttr')}>
                {t('editor.assets.levelGroupTitle')}
                <button type="button" className="asset-action-btn asset-group-add" title={t('editor.assets.newEmptySceneTitle')}
                  onClick={() => newScene(false)}>＋</button>
              </div>
              {levelScenes.map((s) => {
                const isOpen = openSceneFile === s.id;
                return (
                  <div key={s.id} className="asset-row" data-testid={`asset-scene-${s.id}`}
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
                  <div key={s.id} className="asset-row" data-testid={`asset-scene-${s.id}`}
                    title={t('editor.assets.assetRowTitle', { pack: s.pack })}
                    onDoubleClick={() => requestOpenScene(s.id)}>
                    <span className="asset-swatch">{isChar ? '🧍' : '🐮'}</span>
                    <span className="asset-name">{s.name ?? s.id}</span>
                    <span className="asset-kind">{isChar ? 'character' : 'monster'}</span>
                    {isOpen && <span className="asset-processed-badge" title={t('editor.assets.editing')}>✎</span>}
                  </div>
                );
              })}
              <div className="asset-group-title">{t('editor.assets.materialGroupTitle')}</div>
            </>
          )}
          {loading ? (
            <div className="muted" style={{ padding: '4px 10px' }}>loading…</div>
          ) : packs.length === 0 ? (
            <div className="muted" style={{ padding: '4px 10px' }} data-testid="asset-empty">
              {t('editor.assets.emptyPacks')}
            </div>
          ) : packs.filter((a) => a.kind !== 'scene').map((a) => {
            // Hide `kind: 'scene'` sub-pack rows here — every level pack
            // contains exactly one scene asset entry whose name reads as
            // an opaque hex (`scene ad7cca38`) and whose double-click
            // can't preview anything; the level itself is already in the
            // 关卡 group above. Materials still list (with a pack-stem
            // prefix from shortName so '<level1 · 1c720a13>' tells the
            // user where it came from).
            const swatch = materialSwatch(a);
            return (
              <div key={a.guid} className="asset-row" data-testid={`asset-${a.guid}`}
                title={`${a.kind} · ${a.guid}\n${a.packPath}`}
                onContextMenu={(e) => openMenu(a, e)}
                onDoubleClick={() => assign(a.guid)}>
                <span className="asset-swatch" style={swatch ? { background: swatch } : undefined}>
                  {swatch ? '' : a.kind === 'mesh' ? '◫' : a.kind === 'texture' ? '🖼' : '?'}
                </span>
                <span className="asset-name">{a.name}</span>
                <span className="asset-kind">{a.kind}</span>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'files' && (
        <div className="asset-list" data-testid="asset-file-list">
          {loading ? (
            <div className="muted" style={{ padding: '4px 10px' }}>loading…</div>
          ) : rawFiles.length === 0 ? (
            <div className="muted" style={{ padding: '4px 10px' }}>
              {t('editor.assets.emptyFiles')}
            </div>
          ) : rawFiles.map((raw) => {
            const isProc = processing.has(raw.path);
            const isModel = raw.kind === 'raw-model';
            return (
              <div key={raw.path} className="asset-file-row" data-testid={`raw-${raw.name}`}
                title={raw.path}>
                <span className="asset-file-icon">{KIND_ICON[raw.kind] ?? '📄'}</span>
                <span className="asset-name">{raw.name}</span>
                {isModel && !raw.processed && (
                  <button type="button" className="asset-action-btn" disabled={isProc}
                    title={t('editor.assets.processTitle')}
                    onClick={() => handleProcess(raw)}>
                    {isProc ? '…' : t('editor.assets.processBtn')}
                  </button>
                )}
                {isModel && raw.processed && (
                  <button type="button" className="asset-action-btn ok"
                    title={t('editor.assets.addToSceneTitle')}
                    onClick={() => handleAddToScene(raw)}>
                    {t('editor.assets.addToSceneBtn')}
                  </button>
                )}
                {raw.processed && <span className="asset-processed-badge" title={t('editor.assets.processedBadge')}>✓</span>}
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
