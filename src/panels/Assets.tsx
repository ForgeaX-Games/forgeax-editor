import { useEffect, useState } from 'react';
import { loadGameAssets, materialSwatch, type PackAsset } from '../core/assets';
import { dispatch, getSceneId, getSelection, requestRefAsset, useDocVersion, useSelection } from '../store';

// Assets panel — browses the OPEN game's asset packs (material / texture / mesh,
// from .forgeax/games/<slug>/assets/*.pack.json). Preview a material by its base
// color; right-click → 加入 ForgeaX 对话 / 赋给选中实体 (sets the selection's
// Material.materialAsset = guid, so it renders the referenced asset material).
interface Menu { guid: string; x: number; y: number }

export function AssetsPanel() {
  useDocVersion();
  const sel = useSelection();
  const [assets, setAssets] = useState<PackAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [menu, setMenu] = useState<Menu | null>(null);

  const reload = () => {
    setLoading(true);
    void loadGameAssets(getSceneId()).then((a) => { setAssets(a); setLoading(false); });
  };

  useEffect(() => {
    reload();
    // Refresh when the outer EditMode imports a new asset (VAG_ASSETS_CHANGED).
    const onMsg = (ev: MessageEvent) => {
      const d = ev.data as { type?: string } | null;
      if (d?.type === 'VAG_ASSETS_CHANGED') reload();
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const menuAsset = menu ? assets.find((a) => a.guid === menu.guid) : undefined;

  function assign(guid: string): void {
    const id = getSelection();
    if (id === null) return;
    dispatch({ kind: 'setComponent', entity: id, component: 'Material', patch: { materialAsset: guid } });
  }

  return (
    <div className="panel ed-assets" data-testid="panel-assets" onClick={() => menu && setMenu(null)}>
      <h3>Assets</h3>
      <div className="asset-list" data-testid="asset-list">
        {loading ? (
          <div className="muted" style={{ padding: '4px 10px' }}>loading…</div>
        ) : assets.length === 0 ? (
          <div className="muted" style={{ padding: '4px 10px' }} data-testid="asset-empty">
            该游戏 assets/ 下无 *.pack.json
          </div>
        ) : (
          assets.map((a) => {
            const swatch = materialSwatch(a);
            return (
              <div
                key={a.guid}
                className="asset-row"
                data-testid={`asset-${a.guid}`}
                title={`${a.kind} · ${a.guid}\n${a.packPath}`}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ guid: a.guid, x: e.clientX, y: e.clientY }); }}
                onDoubleClick={() => assign(a.guid)}
              >
                <span className="asset-swatch" style={swatch ? { background: swatch } : undefined}>
                  {swatch ? '' : a.kind === 'mesh' ? '◫' : a.kind === 'texture' ? '🖼' : '?'}
                </span>
                <span className="asset-name">{a.name}</span>
                <span className="asset-kind">{a.kind}</span>
              </div>
            );
          })
        )}
      </div>
      {menu && menuAsset && (
        <div className="ctxmenu" data-testid="asset-ctxmenu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <div
            className={`ctxitem${sel === null ? ' disabled' : ''}`}
            data-testid="asset-ctx-assign"
            onClick={() => { if (sel !== null) assign(menu.guid); setMenu(null); }}
          >
            赋给选中实体{sel === null ? '(先选一个)' : ''}
          </div>
          <div
            className="ctxitem"
            data-testid="asset-ctx-ref"
            onClick={() => { requestRefAsset({ guid: menuAsset.guid, kind: menuAsset.kind, name: menuAsset.name, packPath: menuAsset.packPath }); setMenu(null); }}
          >
            加入 ForgeaX 对话
          </div>
          <div
            className="ctxitem"
            data-testid="asset-ctx-copy"
            onClick={() => { void navigator.clipboard?.writeText(menuAsset.guid); setMenu(null); }}
          >
            复制 GUID
          </div>
        </div>
      )}
    </div>
  );
}
