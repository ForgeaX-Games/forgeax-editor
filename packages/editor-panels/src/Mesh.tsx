// Mesh panel — right-dock sibling of the Material panel.
//
// Two modes (mirrors Material.tsx):
//   • Asset preview — a `mesh` sub-asset is selected in the Content Browser
//     (double-click). Geometry stats (vertices / primitives / submeshes / index
//     format / AABB) come from the MAIN window via the `meshStats` broadcast:
//     meta.json mesh sub-assets carry NO geometry in their browser payload, and
//     this panel (an iframe) has no engine asset registry, so the main window
//     loads the mesh (loadByGuid) and publishes derived stats here.
//     Design: docs/design/editor-mesh-panel.md §4.3.
//   • Entity mode — an entity with a `Mesh` component is selected: shows the
//     primitive `kind` + bound `meshAsset` GUID (read-only in v1).
import { bus, useDocVersion, useSelection, useAssetSelection, useMeshStats } from '@forgeax/editor-shared';

const short = (g: string): string => (g.length > 12 ? `${g.slice(0, 8)}…${g.slice(-3)}` : g);

function aabbSize(a: readonly number[]): string {
  const f = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : '—');
  const d = (hi: number, lo: number): number => (a[hi] ?? 0) - (a[lo] ?? 0);
  return `${f(d(3, 0))} × ${f(d(4, 1))} × ${f(d(5, 2))}`;
}

function StatRow({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="mat-row">
      <span className="mat-k">{k}</span>
      <span className="mat-val" style={{ flex: 1, textAlign: 'left' }}>{v}</span>
    </div>
  );
}

/** Read-only preview of a mesh sub-asset selected in the Content Browser.
 *  Stats arrive via the main-window `meshStats` broadcast keyed by GUID. */
function PackMeshPreview({ name, guid }: { name: string; guid: string }) {
  const raw = useMeshStats();
  // Narrow to non-null only when the broadcast matches THIS asset (a stale entry
  // can linger for a frame while the main window reloads on a selection change).
  const stats = raw != null && raw.guid === guid ? raw : null;

  return (
    <div className="panel ed-mesh" data-testid="panel-mesh">
      <h3>Mesh · {name}</h3>
      <div className="mat-row">
        <span className="mat-k">GUID</span>
        <span className="mat-slot on" style={{ fontSize: '10px' }}>{guid}</span>
      </div>
      {stats == null ? (
        <div className="muted mat-hint">加载网格统计…</div>
      ) : stats.error ? (
        <div className="muted mat-hint">无法加载网格统计:{stats.error}</div>
      ) : (
        <>
          <StatRow k="Vertices" v={stats.vertexCount.toLocaleString()} />
          <StatRow k="Primitives" v={stats.primitiveCount.toLocaleString()} />
          <StatRow k="Index fmt" v={stats.indexFormat === 'none' ? '— (non-indexed)' : stats.indexFormat.toUpperCase()} />
          <StatRow k="Submeshes" v={stats.submeshes.length} />
          {stats.submeshes.map((s, i) => (
            <div className="mat-row" key={i} style={{ paddingLeft: 12 }}>
              <span className="mat-k">· {i}</span>
              <span className="mat-val" style={{ flex: 1, textAlign: 'left' }}>{s.topology} · {s.primitiveCount}</span>
            </div>
          ))}
          {stats.aabb != null && stats.aabb.length === 6 && <StatRow k="Size" v={aabbSize(stats.aabb)} />}
          <StatRow k="Skinned" v={stats.attributes.includes('skinIndex') ? '是' : '否'} />
        </>
      )}
      <div className="muted mat-hint">只读预览。右键资产 → “Assign to selected entity” 应用到实体。</div>
    </div>
  );
}

export function MeshPanel() {
  useDocVersion();
  const sel = useSelection();
  const assetSel = useAssetSelection();
  const node = sel !== null ? bus.doc.entities[sel] : undefined;
  const mesh = node?.components.Mesh as Record<string, unknown> | undefined;

  // No entity selected but a mesh asset is selected in the Content Browser.
  if ((sel === null || !node) && assetSel?.kind === 'mesh') {
    return <PackMeshPreview name={assetSel.name} guid={assetSel.guid} />;
  }
  if (sel === null || !node) {
    return (
      <div className="panel ed-mesh" data-testid="panel-mesh">
        <h3>Mesh</h3>
        <div className="muted mat-empty">选择一个网格资产,或带 Mesh 组件的实体。(whole 导入需先展开 scene 选中其中的 mesh)</div>
      </div>
    );
  }
  if (!mesh) {
    if (assetSel?.kind === 'mesh') return <PackMeshPreview name={assetSel.name} guid={assetSel.guid} />;
    return (
      <div className="panel ed-mesh" data-testid="panel-mesh">
        <h3>Mesh</h3>
        <div className="muted mat-empty">“{node.name}” 没有 Mesh 组件。</div>
      </div>
    );
  }

  // Entity mode — show the primitive kind + bound mesh-asset GUID (read-only, v1).
  const kind = typeof mesh.kind === 'string' ? mesh.kind : '—';
  const guid = typeof mesh.meshAsset === 'string' ? (mesh.meshAsset as string) : '';
  return (
    <div className="panel ed-mesh" data-testid="panel-mesh">
      <h3>Mesh · {node.name}</h3>
      <StatRow k="Kind" v={kind} />
      <div className="mat-row">
        <span className="mat-k">Mesh Asset</span>
        <span className={`mat-slot${guid ? ' on' : ''}`} title={guid || '内联图元'}>{guid ? short(guid) : '内联图元 (primitive)'}</span>
      </div>
      <div className="muted mat-hint">双击内容浏览器中的网格资产查看其几何统计。绑定编辑见后续版本。</div>
    </div>
  );
}
