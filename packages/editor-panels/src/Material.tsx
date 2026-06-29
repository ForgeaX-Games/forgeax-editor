import { bus, dispatch, useDocVersion, useSelection, useAssetSelection } from '@forgeax/editor-shared';
import { useTranslation } from '@forgeax/editor-shared/i18n';
import { defaultComponentData } from '@forgeax/editor-core';

const hex = (v: unknown, d: string): string => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : d);
const numv = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const short = (g: string): string => (g.length > 12 ? `${g.slice(0, 8)}…${g.slice(-3)}` : g);

function toHex(c: number[]): string {
  const ch = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${ch(c[0] ?? 0)}${ch(c[1] ?? 0)}${ch(c[2] ?? 0)}`;
}

/** Read-only preview of a pack material asset selected in the Content Browser. */
function PackMaterialPreview({ payload, name, guid }: { payload: Record<string, unknown>; name: string; guid: string }) {
  const pv = payload.paramValues as Record<string, unknown> | undefined;
  const bc = Array.isArray(pv?.baseColor) ? pv!.baseColor as number[] : [0.8, 0.8, 0.8];
  const em = Array.isArray(pv?.emissive) ? pv!.emissive as number[] : [0, 0, 0];
  const roughness = typeof pv?.roughness === 'number' ? pv!.roughness : 0.8;
  const metallic = typeof pv?.metallic === 'number' ? pv!.metallic : 0;
  const emInt = typeof pv?.emissiveIntensity === 'number' ? pv!.emissiveIntensity : 1;
  const passes = payload.passes as { shader?: string }[] | undefined;
  const shading = /unlit/i.test(passes?.[0]?.shader ?? '') ? 'unlit' : 'standard';
  const albedoHex = toHex(bc);
  const emissiveHex = toHex(em);

  return (
    <div className="panel ed-material" data-testid="panel-material">
      <h3>Material · {name} <span className="insp-id">(pack)</span></h3>
      <div className="mat-row">
        <span className="mat-k">GUID</span>
        <span className="mat-slot on" style={{ fontSize: '10px' }}>{guid}</span>
      </div>
      <div className="mat-row">
        <span className="mat-k">Albedo</span>
        <input type="color" className="mat-color" value={albedoHex} disabled />
        <span className="mat-hex">{albedoHex}</span>
      </div>
      <div className="mat-row">
        <span className="mat-k">Metallic</span>
        <input type="range" min={0} max={1} step={0.01} value={metallic} disabled />
        <span className="mat-val">{metallic.toFixed(2)}</span>
      </div>
      <div className="mat-row">
        <span className="mat-k">Roughness</span>
        <input type="range" min={0} max={1} step={0.01} value={roughness} disabled />
        <span className="mat-val">{roughness.toFixed(2)}</span>
      </div>
      <div className="mat-row">
        <span className="mat-k">Emissive</span>
        <input type="color" className="mat-color" value={emissiveHex} disabled />
        <span className="mat-hex">{emissiveHex}</span>
      </div>
      <div className="mat-row">
        <span className="mat-k">Emissive ×</span>
        <input type="range" min={0} max={8} step={0.05} value={emInt} disabled />
        <span className="mat-val">{emInt.toFixed(2)}</span>
      </div>
      <div className="mat-row">
        <span className="mat-k">Shading</span>
        <span className="mat-slot">{shading}</span>
      </div>
      <div className="muted mat-hint">Read-only preview from pack asset. Right-click → "Assign to selected entity" to apply.</div>
    </div>
  );
}

export function MaterialPanel() {
  const { t } = useTranslation();
  useDocVersion();
  const sel = useSelection();
  const assetSel = useAssetSelection();
  const node = sel !== null ? bus.doc.entities[sel] : undefined;
  const mat = node?.components.Material as Record<string, unknown> | undefined;

  // If no entity selected but a material asset is selected in Content Browser, show preview
  if ((sel === null || !node) && assetSel?.kind === 'material') {
    return <PackMaterialPreview payload={assetSel.payload} name={assetSel.name} guid={assetSel.guid} />;
  }

  if (sel === null || !node) {
    return <div className="panel ed-material" data-testid="panel-material"><h3>Material</h3><div className="muted mat-empty">{t('editor.material.selectEntityHint')}</div></div>;
  }
  if (!mat) {
    // Even with entity selected, show pack material preview if one is selected
    if (assetSel?.kind === 'material') {
      return <PackMaterialPreview payload={assetSel.payload} name={assetSel.name} guid={assetSel.guid} />;
    }
    return (
      <div className="panel ed-material" data-testid="panel-material">
        <h3>Material</h3>
        <div className="muted mat-empty">{t('editor.material.noComponent', { name: node.name })}</div>
        <button type="button" className="mat-add" data-testid="mat-add"
          onClick={() => dispatch({ kind: 'addComponent', entity: sel, component: 'Material', value: defaultComponentData('Material') })}>
          {t('editor.material.addMaterial')}
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

      <div className="mat-sec">{t('editor.material.assetsSection')}</div>
      <div className="mat-row">
        <span className="mat-k">Material</span>
        <span className={`mat-slot${guid ? ' on' : ''}`} title={guid || t('editor.material.noAssetTitle')}>{guid ? short(guid) : t('editor.material.inline')}</span>
        {guid && <button type="button" className="mat-clear" title={t('editor.material.clearAsset')} onClick={() => set({ materialAsset: '' })}>×</button>}
      </div>
      {maps.map((m) => {
        const g = typeof mat[m.key] === 'string' ? (mat[m.key] as string) : '';
        return (
          <div className="mat-row" key={m.key}>
            <span className="mat-k">{m.label}</span>
            <span className={`mat-slot${g ? ' on' : ''}`} title={g || t('editor.material.noTexture')}>{g ? short(g) : '—'}</span>
            {g && <button type="button" className="mat-clear" title={t('editor.material.clearTexture')} onClick={() => set({ [m.key]: '' })}>×</button>}
          </div>
        );
      })}
      <div className="muted mat-hint">{t('editor.material.hint')}</div>
    </div>
  );
}
