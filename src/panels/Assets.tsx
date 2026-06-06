import { useEffect, useState } from 'react';
import { loadGameAssets, loadRawAssets, materialSwatch, type PackAsset, type RawAsset } from '../core/assets';
import { bus, dispatch, getSceneId, getSelection, requestRefAsset, useDocVersion, useSelection } from '../store';

// Assets panel — browses the OPEN game's asset packs + raw imported files.
// Tab 1 "PACKS": *.pack.json assets (materials, mesh refs, scene refs).
// Tab 2 "FILES": raw imported files (GLB/PNG/audio) with status badges.
//   - GLB unprocessed → "Process" button → /api/assets/process-gltf
//   - GLB processed → "Add to Scene" button → spawns a SceneRef entity

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

export function AssetsPanel() {
  useDocVersion();
  const sel = useSelection();
  const [tab, setTab] = useState<Tab>('packs');
  const [packs, setPacks] = useState<PackAsset[]>([]);
  const [rawFiles, setRawFiles] = useState<RawAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [processing, setProcessing] = useState<Set<string>>(new Set());

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

  const menuAsset = menu ? packs.find((a) => a.guid === menu.guid) : undefined;

  function assign(guid: string): void {
    const id = getSelection();
    if (id === null) return;
    dispatch({ kind: 'setComponent', entity: id, component: 'Material', patch: { materialAsset: guid } });
  }

  const handleProcess = async (raw: RawAsset) => {
    setProcessing((s) => new Set([...s, raw.path]));
    const res = await processGltf(raw.path);
    setProcessing((s) => { const n = new Set(s); n.delete(raw.path); return n; });
    if (!res.ok) { alert(`处理失败: ${res.error}`); return; }
    alert(`处理完成！产生 ${res.total} 个子资产 (mesh/material/scene 等)`);
    reload();
  };

  const handleAddToScene = (raw: RawAsset) => {
    // Spawn a reference entity pointing to the GLB file path so the
    // user/AI can further configure it with engine-gltf components.
    const name = raw.name.replace(/\.[^.]+$/, '');
    bus.dispatch({
      kind: 'spawnEntity',
      name,
      components: {
        Transform: { x: 0, y: 0, z: 0 },
        // GltfRef marks the entity as a GLB instance for the engine to load.
        GltfRef: { path: raw.path },
      },
    });
  };

  return (
    <div className="panel ed-assets" data-testid="panel-assets" onClick={() => menu && setMenu(null)}>
      <h3>Assets</h3>
      <div className="asset-tabs">
        <button type="button" className={`asset-tab${tab === 'packs' ? ' on' : ''}`} onClick={() => setTab('packs')}>Packs</button>
        <button type="button" className={`asset-tab${tab === 'files' ? ' on' : ''}`} onClick={() => setTab('files')}>Files</button>
        <button type="button" className="asset-reload" title="刷新" onClick={reload}>↻</button>
      </div>

      {tab === 'packs' && (
        <div className="asset-list" data-testid="asset-list">
          {loading ? (
            <div className="muted" style={{ padding: '4px 10px' }}>loading…</div>
          ) : packs.length === 0 ? (
            <div className="muted" style={{ padding: '4px 10px' }} data-testid="asset-empty">
              暂无 *.pack.json — 导入 GLB 后点「Process」生成
            </div>
          ) : packs.map((a) => {
            const swatch = materialSwatch(a);
            return (
              <div key={a.guid} className="asset-row" data-testid={`asset-${a.guid}`}
                title={`${a.kind} · ${a.guid}\n${a.packPath}`}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ guid: a.guid, x: e.clientX, y: e.clientY }); }}
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
              暂无导入文件 — 使用编辑器工具栏的「导入」按钮
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
                    title="生成 meta.json + sub-asset GUIDs，之后才能加入场景"
                    onClick={() => handleProcess(raw)}>
                    {isProc ? '…' : '处理'}
                  </button>
                )}
                {isModel && raw.processed && (
                  <button type="button" className="asset-action-btn ok"
                    title="在当前场景根节点加入该 GLB 的引用实体"
                    onClick={() => handleAddToScene(raw)}>
                    + 场景
                  </button>
                )}
                {raw.processed && <span className="asset-processed-badge" title="已处理 · meta.json 存在">✓</span>}
              </div>
            );
          })}
        </div>
      )}

      {menu && menuAsset && (
        <div className="ctxmenu" data-testid="asset-ctxmenu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <div className={`ctxitem${sel === null ? ' disabled' : ''}`} data-testid="asset-ctx-assign"
            onClick={() => { if (sel !== null) assign(menu.guid); setMenu(null); }}>
            赋给选中实体{sel === null ? '(先选一个)' : ''}
          </div>
          <div className="ctxitem" data-testid="asset-ctx-ref"
            onClick={() => { requestRefAsset({ guid: menuAsset.guid, kind: menuAsset.kind, name: menuAsset.name, packPath: menuAsset.packPath }); setMenu(null); }}>
            加入 ForgeaX 对话
          </div>
          <div className="ctxitem" data-testid="asset-ctx-copy"
            onClick={() => { void navigator.clipboard?.writeText(menuAsset.guid); setMenu(null); }}>
            复制 GUID
          </div>
        </div>
      )}
    </div>
  );
}
