import { bus, dispatch, useDocVersion, useSelection, useAssetSelection, entIsDeadWorld } from '@forgeax/editor-shared';
import { useTranslation } from '@forgeax/editor-shared/i18n';
import { floatToHex, hexToFloat } from '@forgeax/editor-core';
import {
  MeshRenderer,
  Materials,
} from '@forgeax/engine-runtime';
// F-2 (review round 1): `Entity` is engine-ecs's `defineComponent` VALUE (the
// entity-id component token), not a type — using it as one trips TS2709. The
// type-space handle for a `world.set(handle, ...)` argument is `EntityHandle`
// (mirrors play-runtime/main.ts:25). AGENTS.md #5: verify engine symbols.
import type { EntityHandle } from '@forgeax/engine-ecs';
// MeshRenderer.materials + world.sharedRefs.resolve speak the two-axis phantom
// handle `Handle<'MaterialAsset','shared'>`, not a raw number — carry the brand
// through so allocSharedRef's result flows into world.set without a cast.
import type { Handle } from '@forgeax/engine-runtime';

type MaterialHandle = Handle<'MaterialAsset', 'shared'>;

const short = (g: string): string => (g.length > 12 ? `${g.slice(0, 8)}...${g.slice(-3)}` : g);

// ── Helpers ───────────────────────────────────────────────────────────────────

interface MatParams {
  baseColor: [number, number, number, number];
  metallic: number;
  roughness: number;
  emissive: [number, number, number];
  emissiveIntensity: number;
}

function readMatParams(pv: Record<string, unknown> | undefined): MatParams {
  const bc = Array.isArray(pv?.baseColor) ? (pv!.baseColor as number[]) : [0.8, 0.8, 0.8, 1];
  const em = Array.isArray(pv?.emissive) ? (pv!.emissive as number[]) : [0, 0, 0];
  return {
    baseColor: [bc[0] ?? 0.8, bc[1] ?? 0.8, bc[2] ?? 0.8, bc[3] ?? 1],
    metallic: typeof pv?.metallic === 'number' ? pv!.metallic : 0,
    roughness: typeof pv?.roughness === 'number' ? pv!.roughness : 0.5,
    emissive: [em[0] ?? 0, em[1] ?? 0, em[2] ?? 0],
    emissiveIntensity: typeof pv?.emissiveIntensity === 'number' ? pv!.emissiveIntensity : 1,
  };
}

// ── Read-only pack material preview ───────────────────────────────────────────

/** Read-only preview of a pack material asset selected in the Content Browser. */
function PackMaterialPreview({ payload, name, guid }: { payload: Record<string, unknown>; name: string; guid: string }) {
  const pv = payload.paramValues as Record<string, unknown> | undefined;
  const m = readMatParams(pv);
  const passes = payload.passes as { shader?: string }[] | undefined;
  const shading = /unlit/i.test(passes?.[0]?.shader ?? '') ? 'unlit' : 'standard';
  const albedoHex = floatToHex(m.baseColor);
  const emissiveHex = floatToHex(m.emissive);

  return (
    <div className="panel ed-material" data-testid="panel-material">
      <h3>Material . {name} <span className="insp-id">(pack)</span></h3>
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
        <input type="range" min={0} max={1} step={0.01} value={m.metallic} disabled />
        <span className="mat-val">{m.metallic.toFixed(2)}</span>
      </div>
      <div className="mat-row">
        <span className="mat-k">Roughness</span>
        <input type="range" min={0} max={1} step={0.01} value={m.roughness} disabled />
        <span className="mat-val">{m.roughness.toFixed(2)}</span>
      </div>
      <div className="mat-row">
        <span className="mat-k">Emissive</span>
        <input type="color" className="mat-color" value={emissiveHex} disabled />
        <span className="mat-hex">{emissiveHex}</span>
      </div>
      <div className="mat-row">
        <span className="mat-k">Emissive x</span>
        <input type="range" min={0} max={8} step={0.05} value={m.emissiveIntensity} disabled />
        <span className="mat-val">{m.emissiveIntensity.toFixed(2)}</span>
      </div>
      <div className="mat-row">
        <span className="mat-k">Shading</span>
        <span className="mat-slot">{shading}</span>
      </div>
      <div className="muted mat-hint">Read-only preview from pack asset. Right-click - "Assign to selected entity" to apply.</div>
    </div>
  );
}

// ── Entity MaterialAsset editor ───────────────────────────────────────────────

function EntityMaterialEditor({ entity, matHandle, mr }: { entity: EntityHandle; matHandle: MaterialHandle; mr: { materials: readonly MaterialHandle[] } }) {
  const world = bus.doc.world;
  const res = world.sharedRefs.resolve(matHandle);
  if (!res.ok) {
    return (
      <div className="panel ed-material" data-testid="panel-material">
        <h3>Material</h3>
        <div className="muted mat-empty">MaterialAsset resolved failed: {res.error.code}</div>
      </div>
    );
  }
  const payload = res.value as { paramValues?: Record<string, unknown> };
  const m = readMatParams(payload.paramValues);

  const albedoHex = floatToHex(m.baseColor);
  const emissiveHex = floatToHex(m.emissive);

  const commit = (patch: Partial<MatParams>): void => {
    const next: MatParams = { ...m, ...patch };
    const newMat = Materials.standard({
      baseColor: [...next.baseColor] as [number, number, number, number],
      metallic: next.metallic,
      roughness: next.roughness,
      ...(next.emissive.some((v) => v !== 0)
        ? { emissive: [...next.emissive] }
        : {}),
      ...(next.emissiveIntensity !== 1
        ? { emissiveIntensity: next.emissiveIntensity }
        : {}),
    });
    const newHandle = world.allocSharedRef(
      'MaterialAsset',
      newMat as Parameters<typeof world.allocSharedRef>[1],
    );
    // Update the entity's MeshRenderer to reference the new material handle.
    const updatedMaterials = mr.materials.map((h, i) => (i === 0 ? newHandle : h));
    world.set(entity, MeshRenderer, { materials: updatedMaterials });
  };

  return (
    <div className="panel ed-material" data-testid="panel-material">
      <h3>Material . <span className="insp-id">MaterialAsset</span></h3>

      <div className="mat-row">
        <span className="mat-k">Albedo</span>
        <input type="color" className="mat-color" value={albedoHex} data-testid="mat-albedo"
          onChange={(e) => {
            const [r, g, b] = hexToFloat(e.target.value);
            commit({ baseColor: [r!, g!, b!, m.baseColor[3]!] });
          }} />
        <span className="mat-hex">{albedoHex}</span>
      </div>

      <div className="mat-row">
        <span className="mat-k">Metallic</span>
        <input type="range" min={0} max={1} step={0.01} value={m.metallic} data-testid="mat-metallic"
          onChange={(e) => { commit({ metallic: Number(e.target.value) }); }} />
        <span className="mat-val">{m.metallic.toFixed(2)}</span>
      </div>
      <div className="mat-row">
        <span className="mat-k">Roughness</span>
        <input type="range" min={0} max={1} step={0.01} value={m.roughness} data-testid="mat-roughness"
          onChange={(e) => { commit({ roughness: Number(e.target.value) }); }} />
        <span className="mat-val">{m.roughness.toFixed(2)}</span>
      </div>

      <div className="mat-row">
        <span className="mat-k">Emissive</span>
        <input type="color" className="mat-color" value={emissiveHex} data-testid="mat-emissive"
          onChange={(e) => {
            const [r, g, b] = hexToFloat(e.target.value);
            commit({ emissive: [r!, g!, b!] });
          }} />
        <span className="mat-hex">{emissiveHex}</span>
      </div>
      <div className="mat-row">
        <span className="mat-k">Emissive x</span>
        <input type="range" min={0} max={8} step={0.05} value={m.emissiveIntensity} data-testid="mat-emissive-int"
          onChange={(e) => { commit({ emissiveIntensity: Number(e.target.value) }); }} />
        <span className="mat-val">{m.emissiveIntensity.toFixed(2)}</span>
      </div>

      <div className="muted mat-hint">Editing MaterialAsset scalar PBR parameters.</div>
    </div>
  );
}

// ── Panel entry ───────────────────────────────────────────────────────────────

export function MaterialPanel() {
  const { t } = useTranslation();
  useDocVersion();
  const sel = useSelection();
  const assetSel = useAssetSelection();
  const world = bus.doc.world;

  // If a material asset is selected in Content Browser, show read-only preview.
  // (This path needs no live world — the payload rides the asset selection.)
  if (assetSel?.kind === 'material') {
    return <PackMaterialPreview payload={assetSel.payload} name={assetSel.name} guid={assetSel.guid} />;
  }

  if (sel === null) {
    return <div className="panel ed-material" data-testid="panel-material"><h3>Material</h3><div className="muted mat-empty">{t('editor.material.selectEntityHint')}</div></div>;
  }

  // Popout guard: in a popped-out window bus.doc.world is null (snapshot revive
  // keeps it inert) AND the MaterialAsset shared-ref payloads aren't in the popout
  // cache, so entity-material editing genuinely can't run here. Every path below
  // dereferences the live world (world.get / world.sharedRefs.resolve) — without
  // this guard selecting an entity NPE'd ("reading 'get'"), same class as the
  // childrenOf (#5) / Inspector (#10) popout crashes. Degrade gracefully: the
  // editable Material panel lives in the main window.
  if (world === null || entIsDeadWorld(bus.doc)) {
    return (
      <div className="panel ed-material" data-testid="panel-material">
        <h3>Material</h3>
        <div className="muted mat-empty">Material editing is available in the main editor window.</div>
      </div>
    );
  }
  // useSelection yields a plain EntityId (number); brand it once as the engine's
  // EntityHandle so every world API below (get / EntityMaterialEditor entity) is
  // type-correct without per-call casts.
  const selH = sel as EntityHandle;

  // Check if the selected entity has MeshRenderer with materials.
  const mrRes = world.get(selH, MeshRenderer);
  if (!mrRes.ok) {
    // Also check pack material preview.
    if (assetSel?.kind === 'material') {
      return <PackMaterialPreview payload={assetSel.payload} name={assetSel.name} guid={assetSel.guid} />;
    }
    return (
      <div className="panel ed-material" data-testid="panel-material">
        <h3>Material</h3>
        <div className="muted mat-empty">{t('editor.material.noComponent', { name: String(sel) })}</div>
      </div>
    );
  }

  const mr = mrRes.value as { materials: readonly MaterialHandle[] };
  if (!Array.isArray(mr.materials) || mr.materials.length === 0) {
    return (
      <div className="panel ed-material" data-testid="panel-material">
        <h3>Material</h3>
        <div className="muted mat-empty">No material assigned to this entity.</div>
      </div>
    );
  }

  return <EntityMaterialEditor entity={selH} matHandle={mr.materials[0]!} mr={mr} />;
}