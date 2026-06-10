import { bus, dispatch, useDocVersion, useSelection } from '@forgeax/editor-edit-runtime';
import { defaultComponentData } from '@forgeax/editor-core';

// Material panel (design spec 域: Material 专属面板) — a focused PBR surface for the
// selected entity's Material component: big color swatches + sliders, emissive,
// shading mode, and the asset/texture GUID slots. It complements the schema-driven
// Inspector with a dedicated, larger editing surface; every edit is a setComponent
// command (undoable, same bus as the AI), exactly like the Inspector.

const hex = (v: unknown, d: string): string => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : d);
const numv = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const short = (g: string): string => (g.length > 12 ? `${g.slice(0, 8)}…${g.slice(-3)}` : g);

export function MaterialPanel() {
  useDocVersion();
  const sel = useSelection();
  const node = sel !== null ? bus.doc.entities[sel] : undefined;
  const mat = node?.components.Material as Record<string, unknown> | undefined;

  if (sel === null || !node) {
    return <div className="panel ed-material" data-testid="panel-material"><h3>Material</h3><div className="muted mat-empty">选中一个实体以编辑材质。</div></div>;
  }
  if (!mat) {
    return (
      <div className="panel ed-material" data-testid="panel-material">
        <h3>Material</h3>
        <div className="muted mat-empty">「{node.name}」没有 Material 组件。</div>
        <button type="button" className="mat-add" data-testid="mat-add"
          onClick={() => dispatch({ kind: 'addComponent', entity: sel, component: 'Material', value: defaultComponentData('Material') })}>
          + 添加 Material
        </button>
      </div>
    );
  }

  const set = (patch: Record<string, unknown>): void => { dispatch({ kind: 'setComponent', entity: sel, component: 'Material', patch }); };
  const albedo = hex(mat.albedo, '#cccccc');
  const emissive = hex(mat.emissive, '#000000');
  const metallic = numv(mat.metallic, 0);
  const roughness = numv(mat.roughness, 0.8);
  const emInt = numv(mat.emissiveIntensity, 1);
  const shading = (mat.shading as string) === 'unlit' ? 'unlit' : 'standard';
  const guid = typeof mat.materialAsset === 'string' ? mat.materialAsset : '';

  const maps: { key: string; label: string }[] = [
    { key: 'albedoMap', label: 'Albedo' },
    { key: 'normalMap', label: 'Normal' },
    { key: 'ormMap', label: 'ORM' },
  ];

  return (
    <div className="panel ed-material" data-testid="panel-material">
      <h3>Material · {node.name}</h3>

      <div className="mat-row">
        <span className="mat-k">Albedo</span>
        <input type="color" className="mat-color" value={albedo} data-testid="mat-albedo" onChange={(e) => set({ albedo: e.target.value })} />
        <span className="mat-hex">{albedo}</span>
      </div>

      <div className="mat-row">
        <span className="mat-k">Metallic</span>
        <input type="range" min={0} max={1} step={0.01} value={metallic} data-testid="mat-metallic" onChange={(e) => set({ metallic: Number(e.target.value) })} />
        <span className="mat-val">{metallic.toFixed(2)}</span>
      </div>
      <div className="mat-row">
        <span className="mat-k">Roughness</span>
        <input type="range" min={0} max={1} step={0.01} value={roughness} data-testid="mat-roughness" onChange={(e) => set({ roughness: Number(e.target.value) })} />
        <span className="mat-val">{roughness.toFixed(2)}</span>
      </div>

      <div className="mat-row">
        <span className="mat-k">Emissive</span>
        <input type="color" className="mat-color" value={emissive} data-testid="mat-emissive" onChange={(e) => set({ emissive: e.target.value })} />
        <span className="mat-hex">{emissive}</span>
      </div>
      <div className="mat-row">
        <span className="mat-k">Emissive ×</span>
        <input type="range" min={0} max={8} step={0.05} value={emInt} data-testid="mat-emissive-int" onChange={(e) => set({ emissiveIntensity: Number(e.target.value) })} />
        <span className="mat-val">{emInt.toFixed(2)}</span>
      </div>

      <div className="mat-row">
        <span className="mat-k">Shading</span>
        <select className="mat-select" value={shading} data-testid="mat-shading" onChange={(e) => set({ shading: e.target.value })}>
          <option value="standard">standard (PBR)</option>
          <option value="unlit">unlit (flat)</option>
        </select>
      </div>

      <div className="mat-sec">资产 / 贴图 (GUID)</div>
      <div className="mat-row">
        <span className="mat-k">Material</span>
        <span className={`mat-slot${guid ? ' on' : ''}`} title={guid || '未引用资产 — 用内联 PBR'}>{guid ? short(guid) : '内联'}</span>
        {guid && <button type="button" className="mat-clear" title="清除资产引用" onClick={() => set({ materialAsset: '' })}>×</button>}
      </div>
      {maps.map((m) => {
        const g = typeof mat[m.key] === 'string' ? (mat[m.key] as string) : '';
        return (
          <div className="mat-row" key={m.key}>
            <span className="mat-k">{m.label}</span>
            <span className={`mat-slot${g ? ' on' : ''}`} title={g || '无贴图'}>{g ? short(g) : '—'}</span>
            {g && <button type="button" className="mat-clear" title="清除贴图" onClick={() => set({ [m.key]: '' })}>×</button>}
          </div>
        );
      })}
      <div className="muted mat-hint">提示：从 Assets 面板右键「赋给选中实体」可设材质资产 GUID。</div>
    </div>
  );
}
