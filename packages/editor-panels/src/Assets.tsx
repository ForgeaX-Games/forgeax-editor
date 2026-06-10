import { useEffect, useState } from 'react';
import { showContextMenu } from '@forgeax/editor-edit-runtime';
import { loadGameAssets, loadRawAssets, materialSwatch, type PackAsset, type RawAsset } from '@forgeax/editor-core';
import { bus, dispatch, getSceneId, getSelection, requestRefAsset, useDocVersion, useSelection } from '@forgeax/editor-edit-runtime';

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
  useDocVersion();
  const sel = useSelection();
  const [tab, setTab] = useState<Tab>('packs');
  const [packs, setPacks] = useState<PackAsset[]>([]);
  const [rawFiles, setRawFiles] = useState<RawAsset[]>([]);
  const [loading, setLoading] = useState(true);
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

  // Right-click menu → shared service (renders at the top layer of the whole
  // window / posts to the interface parent; never clipped by this panel).
  const openMenu = (a: PackAsset, e: { clientX: number; clientY: number; preventDefault: () => void }) => {
    showContextMenu(e, [
      { label: `赋给选中实体${sel === null ? '(先选一个)' : ''}`, disabled: sel === null, onClick: () => { if (sel !== null) assign(a.guid); } },
      { label: '引用到 Chat', onClick: () => requestRefAsset({ guid: a.guid, kind: a.kind, name: a.name, packPath: a.packPath }) },
      { label: '复制 GUID', onClick: () => { void navigator.clipboard?.writeText(a.guid); } },
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
    if (!res.ok) { alert(`处理失败: ${res.error}`); return; }
    alert(`处理完成！产生 ${res.total} 个子资产 (mesh/material/scene 等)`);
    reload();
  };

  const handleAddToScene = async (raw: RawAsset) => {
    const res = await importScene(raw.path, 'auto');
    if (!res.ok) { alert(`导入场景失败: ${res.error}`); return; }
    if (res.warning) {
      const proceed = confirm(`${res.warning}\n\n确认以「单一引用实体」方式导入?`);
      if (!proceed) return;
    }
    if (res.mode === 'reference' && res.entity) {
      // Single GltfRef entity — recommended for large scenes.
      const e = res.entity as { name: string; components: Record<string, unknown> };
      bus.dispatch({ kind: 'spawnEntity', name: e.name, components: e.components });
      alert(`已导入「${e.name}」(${res.totalNodes} 节点 · ${res.meshCount} mesh)。\n\n真实几何体由运行时 glTF 加载器异步载入——先看到占位方块，几秒后替换为真实模型（编辑器 + Play 都生效）。大场景节点多时编辑提交会略卡。`);
    } else if (res.mode === 'full' && res.doc) {
      // Full import: dispatch all entities as a transaction.
      const doc = res.doc;
      const cmds = doc.order.map((id) => {
        const ent = doc.entities[id] as { name: string; parent: number | null; components: Record<string, unknown> };
        return { kind: 'spawnEntity' as const, name: ent.name, parent: ent.parent ?? undefined, components: ent.components };
      });
      bus.dispatch({ kind: 'transaction', label: `Import GLB: ${raw.name}`, commands: cmds });
      alert(`已导入 ${res.totalNodes} 个场景实体。`);
    }
  };

  return (
    <div className="panel ed-assets" data-testid="panel-assets">
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

    </div>
  );
}
