import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { showContextMenu } from '@forgeax/editor-core';
import { childrenOf } from '@forgeax/editor-core';
import { clampToField, defaultComponentData, eulerToQuat, fieldSchema, fieldVisible, getComponentSchema, listComponentSchemas, quatToEuler, type FieldSchema } from '@forgeax/editor-core';
// M3 (AC-03, plan-strategy §2 D-6): mutations + view-intent ops go through the
// one gateway door — gateway.dispatch({ kind, … }) — replacing the direct setters
// (setSelectionMany / requestFrame) and the origin-less `dispatch` wrapper.
import { gateway, requestRefComponent, useDocVersion, useFieldPreview, useSelection, useSelectionList } from '@forgeax/editor-core';
import { entExists, entName, entParent, entComponent, entComponents, worldEntityHandles } from '@forgeax/editor-core';
// VERIFY finding-3 (defense-in-depth): the world-bound handle-pair + the live
// active-read-world binding, so the primary Inspector reads run the three-layer
// validateHandlePair check (world-mismatch / epoch / generation) at the read seam
// instead of only the legacy isStale liveness fallback. Both come from core's IoC
// seams — getSelectionPair (super door) + getActiveReadBinding (world-manager fills
// it at boot). In headless / play mode (no binding) readOpts returns undefined and
// the reads keep the legacy path unchanged.
import { getSelectionPair, getActiveReadBinding } from '@forgeax/editor-core';
import type { EditorOp, EntityHandle, HandleCheckOpts } from '@forgeax/editor-core';
// Editor UI primitive: the interaction-spec icon set (editor-ui-primitives-plan).
// Panels consume shared primitives from @forgeax/editor-ui (already a transitive
// dep via content-browser); the ForgeaxIcon registry reproduces the spec glyphs
// 1:1 (stroke-width 1.7) instead of approximating with lucide.
import {
  ForgeaxIcon,
  type ForgeaxIconName,
  // Shared asset-preview primitive (SSOT for the kind→visual mapping); the
  // Content Browser cards render the same deriver. Panels reference the ui
  // primitive rather than reaching into the content-browser panel.
  AssetThumbnail,
  // Form/menu primitives (editor-ui-primitives-plan): the Inspector consumes the
  // shared shadcn-over-tokens components instead of native <select>/<input
  // type=checkbox>/ad-hoc popovers. DropdownMenu reproduces the app-wide menu
  // panel (same Radix menu the Hierarchy right-click uses); Checkbox `size=menu`
  // is the 15px glyph the interaction spec's `.chk` was hand-rolling.
  Checkbox,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@forgeax/editor-ui';
import { useNumberDraft } from './useNumberDraft';
import { AssetPicker } from './AssetPicker';
import './inspector.css';

// Component → header/section glyph (interaction spec). Falls back to `box`.
const COMP_ICON: Record<string, ForgeaxIconName> = {
  Name: 'user',
  Transform: 'move3d',
  MeshFilter: 'box',
  MeshRenderer: 'layers',
  Material: 'material',
  Light: 'sun',
  Camera: 'video',
  RigidBody: 'hexagon',
  Rigidbody: 'hexagon',
  Collider: 'hexagon',
  Script: 'activity',
  Animator: 'film',
  Animation: 'film',
  Sprite: 'star',
  Audio: 'play',
  AudioSource: 'play',
  ParticleSystem: 'spark',
};
function compIcon(name: string): ForgeaxIconName {
  return COMP_ICON[name] ?? 'box';
}
// A small dim accent per component (colored cat-head left border), mirroring the
// spec's category rails. Per the interaction spec's semantics:
//   dim-all  (teal)  → universal, present on every object → Transform
//   dim-type (lime)  → the object's type-defining components (StaticMesh / Light /
//                      Camera / Sprite / Material)
//   dim-cap  (amber) → capability/behaviour add-ons (Rendering / Collision /
//                      Physics / Audio / Script / …) → everything else
// (Previously Transform wrongly got the bright lime `dim-type`, which read much
// louder than the other rails.)
const DIM_TYPE_COMPONENTS = new Set(['MeshFilter', 'Light', 'Camera', 'Sprite', 'Material']);
function compDim(name: string): 'dim-type' | 'dim-all' | 'dim-cap' {
  if (name === 'Transform' || name === 'Entity') return 'dim-all';
  if (DIM_TYPE_COMPONENTS.has(name)) return 'dim-type';
  return 'dim-cap';
}
function headerIcon(components: Record<string, unknown>): ForgeaxIconName {
  if (components.Light) return 'sun';
  if (components.Camera) return 'video';
  if (components.MeshRenderer || components.MeshFilter) return 'box';
  return 'hexagon';
}
function deriveKind(components: Record<string, unknown>): string {
  if (components.Light) return 'Light';
  if (components.Camera) return 'Camera';
  if (components.MeshRenderer || components.MeshFilter) return 'Mesh';
  return 'Entity';
}

// Derive a field's expected asset-union type (e.g. 'MeshAsset') from the engine
// component schema's raw type keyword ('shared<MeshAsset>' / 'array<shared<
// MaterialAsset>>'). This editor copy's FieldSchema doesn't carry assetType, so
// we read it live from gateway.describeComponent — the SSOT the drop path trusts.
function expectedAssetType(comp: string, field: string): string | undefined {
  const d = gateway.describeComponent(comp);
  if (!d.ok) return undefined;
  const raw = d.schema[field] ?? '';
  return /shared<([^>]+)>/.exec(raw)?.[1];
}

// Submesh count of the mesh bound to this entity's MeshFilter, or null when there
// is no MeshFilter / the handle can't be resolved. The engine requires
// MeshRenderer.materials.length === MeshAsset.submeshes.length (checked per-frame
// in RenderSystem.extract), so the Inspector uses this to size the material slots
// exactly and refuse to grow the array past the submesh count.
function meshSubmeshCount(nodeComponents: Record<string, unknown>): number | null {
  const mf = nodeComponents.MeshFilter as Record<string, unknown> | undefined;
  if (!mf) return null;
  const raw = mf.assetHandle as unknown;
  const handle = typeof raw === 'number'
    ? raw
    : raw && typeof raw === 'object' && 'raw' in raw
      ? Number((raw as { raw: unknown }).raw)
      : NaN;
  if (!Number.isFinite(handle) || handle <= 0) return null;
  const d = gateway.describeAsset(handle);
  if (!d.ok) return null;
  const sm = (d.meta as Record<string, unknown> | undefined)?.submeshes;
  return Array.isArray(sm) ? sm.length : null;
}

// Entity name editor — draft/abort pattern (Esc reverts, Enter/blur commits).
function NameField({ value, onCommit }: { value: string; onCommit: (name: string) => void }) {
  const [draft, setDraft] = useState(value);
  const abort = useRef(false);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <input
      className="ninput"
      data-testid="insp-name"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (abort.current) { abort.current = false; setDraft(value); return; } onCommit(draft.trim()); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); abort.current = true; (e.target as HTMLInputElement).blur(); }
      }}
    />
  );
}

// DCC-style scrub-able number box. A single click focuses the box for typing; a
// horizontal drag (past a small threshold) scrubs the value with a LOCAL preview
// and commits once on release (one undo step). Typing still commits on blur/Enter.
// Playwright's .fill()+.blur() path (used by super-four e2e on insp-Transform-pos-*)
// is unaffected — it focuses+types+blurs and never crosses the drag threshold.
function ScrubInput({
  value, fs, testid, className, title, onCommit,
}: {
  value: number;
  fs?: FieldSchema | undefined;
  testid: string;
  className: string;
  title?: string | undefined;
  onCommit: (n: number) => void;
}) {
  const [drag, setDrag] = useState<{ ox: number; base: number; v: number } | null>(null);
  const start = useRef<{ x: number } | null>(null);
  const step = fs?.step ?? 0.1;
  const shown = drag ? drag.v : value;
  const num = useNumberDraft(shown, fs, onCommit);
  // spinner / arrow-key parity: shift = ×10, alt = ×0.1 (mirrors useNumberDraft).
  const stepBy = (dir: 1 | -1, e: { shiftKey: boolean; altKey: boolean }) => {
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    num.flush();
    onCommit(clampToField(fs, Math.round((shown + dir * step * mult) * 1e4) / 1e4));
  };
  return (
    <span className={`numfield${className.includes('num') ? ' num' : ''}`}>
      <input
        type="text"
        inputMode="decimal"
        className={`${className} scrubbable`}
        data-testid={testid}
        title={title ?? fs?.tooltip ?? 'drag horizontally to scrub · scroll / ▲▼ to step'}
        value={num.value}
        onFocus={num.onFocus}
        onChange={num.onChange}
        onBlur={num.onBlur}
        onKeyDown={num.onKeyDown}
        onWheel={(e) => { if (document.activeElement === e.currentTarget) { e.preventDefault(); stepBy(e.deltaY < 0 ? 1 : -1, e); } }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          start.current = { x: e.clientX };
          // Don't grab focus on press: a press-and-drag must scrub, not enter
          // text-edit mode. preventDefault on pointerdown suppresses the focus.
          // Focus is granted on pointerup only when the gesture was a clean
          // click (no drag). If already editing, keep default (caret move).
          if (document.activeElement !== e.currentTarget) e.preventDefault();
        }}
        onPointerMove={(e) => {
          if (drag) {
            const cx = e.clientX;
            setDrag((d) => (d ? { ...d, v: clampToField(fs, Math.round((d.base + Math.round(cx - d.ox) * step) * 1e4) / 1e4) } : d));
            return;
          }
          const s = start.current;
          if (!s || Math.abs(e.clientX - s.x) < 4) return;
          num.flush();
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.blur();
          setDrag({ ox: e.clientX, base: value, v: value });
        }}
        onPointerUp={(e) => {
          if (drag) { onCommit(drag.v); setDrag(null); start.current = null; return; }
          // Clean click (no drag): now hand focus to the field for typing.
          if (start.current && document.activeElement !== e.currentTarget) {
            e.currentTarget.focus();
            e.currentTarget.select();
          }
          start.current = null;
        }}
        onPointerCancel={() => { setDrag(null); start.current = null; }}
      />
      <span className="nspin" aria-hidden>
        <button type="button" tabIndex={-1} className="nsp up" onPointerDown={(e) => { e.preventDefault(); stepBy(1, e); }}>
          <ForgeaxIcon name="chevronUp" size={9} />
        </button>
        <button type="button" tabIndex={-1} className="nsp dn" onPointerDown={(e) => { e.preventDefault(); stepBy(-1, e); }}>
          <ForgeaxIcon name="chevronDown" size={9} />
        </button>
      </span>
    </span>
  );
}

// UE-style compact asset preview for the left of an asset field. Instead of a
// raw handle badge, render a real thumbnail: image (texture/image), a material
// baseColor sphere, or a kind-tinted glyph — reusing the Content Browser's
// shared `getThumbnailData` deriver so both surfaces stay 1:1. `bound=false`
// falls back to the dashed empty box.
function AssetPreview({ bound, kind, meta, guid }: { bound: boolean; kind?: string | undefined; meta?: Record<string, unknown> | undefined; guid?: string | undefined }) {
  if (!bound) return <span className="ab empty" />;
  if (!kind) return <span className="ab" />;
  // packPath lets the deriver resolve a real image URL for texture/image kinds;
  // the catalog is the only place that carries it. Missing → glyph fallback.
  const packPath = guid ? (gateway.assetCatalog().find((e) => e.guid === guid)?.relativeUrl ?? '') : '';
  return <AssetThumbnail kind={kind} payload={meta} packPath={packPath} size={15} />;
}

// enum widget — editor-ui Select (Radix) styled compact to sit in a field row.
// The listbox is portaled and picks up the shared `.fx-insp-menu` panel skin.
function EnumSelect({ value, options, testid, onChange }: { value: string; options: string[]; testid: string; onChange: (v: string) => void }) {
  const current = value || options[0] || '';
  return (
    <span className="ddc">
      <Select value={current} onValueChange={onChange}>
        <SelectTrigger className="fx-insp-select" data-testid={testid}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="fx-insp-menu">
          {options.map((opt) => (
            <SelectItem key={opt} value={opt} className="fx-insp-opt">{opt}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  );
}

// bool widget — editor-ui Checkbox `size=menu` (15px, brand-primary when checked)
// matches the interaction spec's `.chk` 1:1. Keeps role=checkbox + testid so the
// e2e/unit assertions and aria-checked semantics are unchanged.
function BoolCheckbox({ checked, testid, onToggle }: { checked: boolean; testid: string; onToggle: (v: boolean) => void }) {
  return (
    <Checkbox
      size="menu"
      data-testid={testid}
      checked={checked}
      onCheckedChange={(c) => onToggle(c === true)}
    />
  );
}

// Default per-axis labels for a `vec` field (indexed). quat uses all four.
const VEC_AXIS_LABELS = ['x', 'y', 'z', 'w'];

// Read a schema `vec` field's axis labels (falls back to x/y/z/w by arity).
function vecAxisLabels(fs: FieldSchema | undefined): string[] {
  const n = fs?.arity ?? 3;
  return fs?.labels ?? VEC_AXIS_LABELS.slice(0, n);
}

// Coerce a stored vec value (number[] | Float32Array | undefined) to a plain
// number[] of the field's arity, filling missing axes from the schema default.
function readVec(fs: FieldSchema | undefined, raw: unknown): number[] {
  const n = fs?.arity ?? 3;
  const def = (Array.isArray(fs?.default) ? (fs?.default as number[]) : undefined) ?? new Array(n).fill(0);
  const src = raw as ArrayLike<number> | undefined;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Number(src?.[i] ?? def[i] ?? 0));
  return out;
}

// ── Linear ⇄ sRGB color conversion (Unreal-style color/intensity split) ───────
function linearToSrgbComponent(c: number): number {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function srgbToLinearComponent(c: number): number {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function linearToSrgbHex(rgb: number[]): string {
  const hex = [0, 1, 2]
    .map((i) => Math.round(linearToSrgbComponent(Number(rgb[i] ?? 0)) * 255))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
  return `#${hex}`;
}

function srgbHexToLinear(hex: string): [number, number, number] {
  const group = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())?.[1];
  if (group === undefined) return [0, 0, 0];
  const int = parseInt(group, 16);
  const r = ((int >> 16) & 0xff) / 255;
  const g = ((int >> 8) & 0xff) / 255;
  const b = (int & 0xff) / 255;
  return [srgbToLinearComponent(r), srgbToLinearComponent(g), srgbToLinearComponent(b)];
}

// Addable/resettable components + their default payloads are derived straight from
// the schema registry (SSOT shared with the Capabilities panel + AI bridge).
const ADDABLE_COMPONENTS: string[] = listComponentSchemas().map((cs) => cs.name);

// Union of a component's schema-declared fields with whatever keys the instance
// actually carries (schema order first) → the inspector surfaces the FULL
// component shape (e.g. empty asset slots) even when the data omits them.
function mergedFieldKeys(comp: string, value: Record<string, unknown>): string[] {
  const schemaKeys = getComponentSchema(comp)?.fields.map((f) => f.key) ?? [];
  return [...new Set([...schemaKeys, ...Object.keys(value)])];
}

function descendantsAndSelf(id: EntityHandle): Set<EntityHandle> {
  const out = new Set<EntityHandle>([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of childrenOf(gateway.activeWorld, cur)) {
      out.add(c);
      stack.push(c);
    }
  }
  return out;
}

// Shallow-equal helper for per-field reset detection (default vs current).
function fieldEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const av = ArrayBuffer.isView(a) ? Array.from(a as unknown as ArrayLike<number>) : a;
  const bv = ArrayBuffer.isView(b) ? Array.from(b as unknown as ArrayLike<number>) : b;
  if (Array.isArray(av) && Array.isArray(bv)) {
    if (av.length !== bv.length) return false;
    return av.every((x, i) => Math.abs(Number(x) - Number(bv[i])) < 1e-6);
  }
  if (typeof av === 'number' && typeof bv === 'number') return Math.abs(av - bv) < 1e-6;
  return false;
}

// Components present on EVERY selected entity (batch edit operates on these).
function commonComponents(ids: EntityHandle[]): string[] {
  if (ids.length === 0) return [];
  const sets = ids.map((id) => new Set(Object.keys(entComponents(gateway.activeWorld, id))));
  return [...sets[0]!].filter((c) => sets.every((s) => s.has(c)));
}

// Multi-select batch editor: one edit fans out to all selected as a single
// transaction → one undo. The primary entity supplies the field layout.
function BatchPanel({ ids }: { ids: EntityHandle[] }) {
  const { t } = useTranslation();
  const primary = ids[ids.length - 1]!;
  const common = commonComponents(ids);

  function setAll(component: string, key: string, value: unknown) {
    const commands: EditorOp[] = ids.map((id) => ({ kind: 'setComponent', entity: id, component, patch: { [key]: value } }));
    gateway.dispatch({ kind: 'transaction', label: `batch ${component}.${key} ×${ids.length}`, commands });
  }

  function alignAxis(axis: 'x' | 'y' | 'z') {
    const axisIdx = { x: 0, y: 1, z: 2 }[axis];
    const posFs = fieldSchema('Transform', 'pos');
    const tr = entComponent(gateway.activeWorld, primary, 'Transform');
    if (!tr.ok) return;
    const target = readVec(posFs, (tr.value as Record<string, unknown>).pos)[axisIdx]!;
    const commands: EditorOp[] = ids.map((id) => {
      const cur = entComponent(gateway.activeWorld, id, 'Transform');
      const p = cur.ok ? readVec(posFs, (cur.value as Record<string, unknown>).pos) : [0, 0, 0];
      p[axisIdx] = target;
      return { kind: 'setComponent', entity: id, component: 'Transform', patch: { pos: p } };
    });
    gateway.dispatch({ kind: 'transaction', label: `align ${axis} ×${ids.length}`, commands });
  }

  const hasTransform = common.includes('Transform');

  return (
    <div className="fx-inspector" data-testid="panel-inspector">
      <div className="dp-name">
        <span className="tico"><ForgeaxIcon name="layers" size={15} /></span>
        <span className="ninput" style={{ display: 'flex', alignItems: 'center', fontWeight: 600 }}>
          {t('editor.inspector.batchTitle', { count: ids.length })}
        </span>
        <button
          type="button"
          className="tico2"
          data-testid="batch-copy-json"
          title="copy all selected entities as a JSON array (for AI / cross-scene paste)"
          onClick={() => {
            const arr = ids.map((id) => ({ id, name: entName(gateway.activeWorld, id), components: entComponents(gateway.activeWorld, id) }));
            void navigator.clipboard?.writeText(JSON.stringify(arr, null, 2));
          }}
        >
          <ForgeaxIcon name="copy" size={15} />
        </button>
      </div>
      <div className="dp-note" data-testid="batch-note">{t('editor.inspector.batchNote')}</div>
      <div className="batch-members" data-testid="batch-members">
        {ids.map((id) => (
          <button
            key={id}
            type="button"
            className={`chip${id === primary ? ' primary' : ''}`}
            data-testid={`batch-chip-${id}`}
            title={id === primary ? 'primary (field layout source)' : 'click to make primary'}
            onClick={() => {
              if (id === primary) return;
              gateway.dispatch({ kind: 'setSelectionMany', ids: [...ids.filter((x) => x !== id), id] });
            }}
          >
            {entName(gateway.activeWorld, id) || id}
            {id === primary ? ' ★' : ''}
          </button>
        ))}
      </div>
      {hasTransform && (
        <div className="dp-comp">
          <div className="ch"><span className="lbl">{t('editor.inspector.alignToPrimary')}</span></div>
          <div className="asset-actions">
            {(['x', 'y', 'z'] as const).map((ax) => (
              <button key={ax} type="button" className="fbtn" data-testid={`batch-align-${ax}`} onClick={() => alignAxis(ax)}>
                {ax.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      )}
      {common.length === 0 && <div className="dp-note">{t('editor.inspector.noCommonComponents')}</div>}
      <div className="dp-body">
        {common.map((comp) => {
          const valueR = entComponent(gateway.activeWorld, primary, comp);
          if (!valueR.ok || typeof valueR.value !== 'object' || valueR.value === null) return null;
          return (
            <div className={`cat ${compDim(comp)}`} key={comp}>
              <div className="cat-head">
                <span className="car"><ForgeaxIcon name={compIcon(comp)} size={13} /></span>
                <span className="ct">{comp}</span>
              </div>
              <div className="cat-fields">
                {(() => {
                  const data = valueR.value as Record<string, unknown>;
                  const vecFields = (getComponentSchema(comp)?.fields ?? []).filter((f) => f.type === 'vec');
                  const vecKeys = new Set(vecFields.map((f) => f.key));
                  const rows: ReactNode[] = [];
                  for (const f of vecFields) {
                    const vec = readVec(f, data[f.key]);
                    if (f.widget === 'color') {
                      const hex = linearToSrgbHex(vec);
                      rows.push(
                        <div className="f-row" data-testid={`batch-field-${comp}-${f.key}`} key={`__vec_${f.key}`}>
                          <span className="f-name" title={f.tooltip}>{f.key}</span>
                          <span className="f-val">
                            <input
                              type="color"
                              className="swatch"
                              data-testid={`batch-${comp}-${f.key}`}
                              value={hex}
                              onChange={(e) => {
                                const rgb = srgbHexToLinear(e.target.value);
                                const commands: EditorOp[] = ids.map((id) => ({ kind: 'setComponent', entity: id, component: comp, patch: { [f.key]: rgb } }));
                                gateway.dispatch({ kind: 'transaction', label: `batch ${comp}.${f.key} ×${ids.length}`, commands });
                              }}
                            />
                            <span className="hexval" data-testid={`batch-${comp}-${f.key}-hex`}>{hex}</span>
                          </span>
                        </div>,
                      );
                      continue;
                    }
                    const labels = vecAxisLabels(f);
                    rows.push(
                      <div className="f-row" data-testid={`batch-${comp}-${f.key}`} key={`__vec_${f.key}`}>
                        <span className="f-name" title={f.tooltip}>{f.key}</span>
                        <span className="f-val vec">
                          {vec.map((axVal, i) => (
                            <span className={`vcell ${labels[i] ?? i}`} key={i}>
                              <ScrubInput
                                key={`${primary}:${comp}:${f.key}:${i}`}
                                value={axVal}
                                fs={{ key: f.key, type: 'number', step: f.step, tooltip: f.tooltip }}
                                testid={`batch-${comp}-${f.key}-${i}`}
                                className="box-i"
                                onCommit={(n) => {
                                  const commands: EditorOp[] = ids.map((id) => {
                                    const cur = entComponent(gateway.activeWorld, id, comp);
                                    const arr = cur.ok ? readVec(f, (cur.value as Record<string, unknown>)[f.key]) : readVec(f, undefined);
                                    arr[i] = n;
                                    return { kind: 'setComponent', entity: id, component: comp, patch: { [f.key]: arr } };
                                  });
                                  gateway.dispatch({ kind: 'transaction', label: `batch ${comp}.${f.key}[${i}] ×${ids.length}`, commands });
                                }}
                              />
                            </span>
                          ))}
                        </span>
                      </div>,
                    );
                  }
                  return [
                    ...rows,
                    ...Object.entries(data)
                      .filter(([k]) => !vecKeys.has(k) && fieldVisible(comp, fieldSchema(comp, k), data))
                      .map(([k, v]) => {
                        const fs = fieldSchema(comp, k);
                        const type = fs?.type ?? (typeof v === 'number' ? 'number' : 'string');
                        return (
                          <div className="f-row" key={k}>
                            <span className="f-name" title={fs?.tooltip}>{k}</span>
                            <span className="f-val">
                              {type === 'bool' ? (
                                <BoolCheckbox checked={v === true} testid={`batch-${comp}-${k}`} onToggle={(c) => setAll(comp, k, c)} />
                              ) : type === 'color' ? (
                                <input type="color" className="swatch" data-testid={`batch-${comp}-${k}`} value={String(v) || '#cccccc'} onChange={(e) => setAll(comp, k, e.target.value)} />
                              ) : type === 'enum' ? (
                                <EnumSelect value={String(v)} options={fs?.options ?? []} testid={`batch-${comp}-${k}`} onChange={(val) => setAll(comp, k, val)} />
                              ) : type === 'number' ? (
                                <ScrubInput key={`${primary}:${comp}:${k}`} value={Number(v)} fs={fs} testid={`batch-${comp}-${k}`} className="box-i num" onCommit={(n) => setAll(comp, k, n)} />
                              ) : (
                                <input className="box-i txt" data-testid={`batch-${comp}-${k}`} value={String(v)} onChange={(e) => setAll(comp, k, e.target.value)} />
                              )}
                            </span>
                          </div>
                        );
                      }),
                  ];
                })()}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Build the super handle-pair read opts for the primary selection, or undefined
 *  when no active-read binding is registered (headless / play mode) or the primary
 *  selection pair no longer matches `sel` (defensive). */
function readOptsFor(sel: EntityHandle): HandleCheckOpts | undefined {
  const binding = getActiveReadBinding();
  if (binding === undefined) return undefined;
  const pair = getSelectionPair();
  if (pair === null || pair.entity !== sel) return undefined;
  return { binding, pair: { worldRef: pair.worldRef, epoch: pair.epoch } };
}

export function InspectorPanel() {
  const { t } = useTranslation();
  useDocVersion();
  const sel = useSelection();
  const selList = useSelectionList();
  const fieldPrev = useFieldPreview();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState('');
  // Open asset-picker target: which field (and array slot) the click-to-browse
  // modal is bound to. null = closed.
  const [picker, setPicker] = useState<{ comp: string; field: string; assetType: string; slot?: number; currentGuid?: string | null } | null>(null);
  // euler React state — scheme B: quat SSOT in world, euler is transient overlay.
  const [euler, setEuler] = useState<{ rotX: number; rotY: number; rotZ: number }>({ rotX: 0, rotY: 0, rotZ: 0 });
  useEffect(() => {
    if (sel === null) return;
    const tv = entComponent(gateway.activeWorld, sel, 'Transform', readOptsFor(sel));
    if (!tv.ok) return;
    const q = readVec(fieldSchema('Transform', 'quat'), (tv.value as Record<string, unknown>).quat);
    setEuler(quatToEuler(q[0]!, q[1]!, q[2]!, q[3]!));
  }, [sel]);
  // Per-component section DOM refs → clicking a chip in the Components strip
  // expands the section and scrolls it into the panel's viewport.
  const catRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const revealComp = (comp: string) => {
    setCollapsed((prev) => { const n = new Set(prev); n.delete(comp); return n; });
    requestAnimationFrame(() => catRefs.current[comp]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };
  const toggleComp = (comp: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(comp)) next.delete(comp);
      else next.add(comp);
      return next;
    });
  const bindPicked = (guid: string): void => {
    if (!picker || sel === null) return;
    gateway.dispatch({
      kind: 'bindAssetRef',
      entity: sel,
      component: picker.comp,
      field: picker.field,
      assetType: picker.assetType,
      guids: [guid],
      ...(picker.slot !== undefined ? { slot: picker.slot } : {}),
    });
  };
  const clearPicked = (): void => {
    if (!picker || sel === null) return;
    if (picker.slot === undefined) {
      gateway.dispatch({ kind: 'setComponent', entity: sel, component: picker.comp, patch: { [picker.field]: '' } });
      return;
    }
    const cur = entComponent(gateway.activeWorld, sel, picker.comp);
    const arr = cur.ok ? Array.from((((cur.value as Record<string, unknown>)[picker.field] ?? []) as ArrayLike<unknown>)) : [];
    arr[picker.slot] = 0;
    gateway.dispatch({ kind: 'setComponent', entity: sel, component: picker.comp, patch: { [picker.field]: arr } });
  };
  if (selList.size > 1) {
    return <BatchPanel ids={[...selList]} />;
  }
  if (sel === null || !entExists(gateway.activeWorld, sel)) {
    return (
      <div className="fx-inspector" data-testid="panel-inspector">
        <div className="dp-empty">{t('editor.inspector.noSelection')}</div>
      </div>
    );
  }
  const nodeName = entName(gateway.activeWorld, sel);
  const nodeParent = entParent(gateway.activeWorld, sel);
  const nodeComponents = entComponents(gateway.activeWorld, sel, readOptsFor(sel));
  const blocked = descendantsAndSelf(sel);
  const parentOptions = worldEntityHandles(gateway.activeWorld).filter((id) => !blocked.has(id));
  const missingComponents = ADDABLE_COMPONENTS.filter((c) => nodeComponents[c] === undefined);
  const bodyComponents = Object.entries(nodeComponents).filter(([comp]) => comp !== 'Name');
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;

  // Whether a component section has any field matching the search (or its name matches).
  const compMatches = (comp: string): boolean => {
    if (!searching) return true;
    if (comp.toLowerCase().includes(q)) return true;
    const val = nodeComponents[comp];
    if (val === null || typeof val !== 'object') return false;
    return mergedFieldKeys(comp, val as Record<string, unknown>).some((k) => k.toLowerCase().includes(q));
  };
  const fieldMatches = (comp: string, key: string): boolean =>
    !searching || comp.toLowerCase().includes(q) || key.toLowerCase().includes(q);

  const anyMatch = bodyComponents.some(([comp]) => compMatches(comp));

  return (
    <div className="fx-inspector" data-testid="panel-inspector">
      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="dp-name">
        <span className="tico"><ForgeaxIcon name={headerIcon(nodeComponents)} size={15} /></span>
        <NameField key={sel} value={nodeName} onCommit={(name) => { if (name && name !== nodeName) gateway.dispatch({ kind: 'rename', entity: sel, name }); }} />
        <span className="idbadge" data-testid="insp-id">#{sel}</span>
        <span className="badge">{deriveKind(nodeComponents)}</span>
        <button type="button" className="tico2" data-testid="insp-focus" title={t('editor.inspector.focus')} onClick={() => gateway.dispatch({ kind: 'requestFrame' })}>
          <ForgeaxIcon name="focus" size={15} />
        </button>
        <button
          type="button"
          className="tico2"
          data-testid="insp-copy-json"
          title={t('editor.inspector.copyJson')}
          onClick={() => {
            void navigator.clipboard?.writeText(JSON.stringify({ name: nodeName, components: nodeComponents }, null, 2));
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
        >
          <ForgeaxIcon name={copied ? 'check' : 'copy'} size={15} />
        </button>
        <button type="button" className="tico2 is-disabled" title={t('editor.inspector.lockDisabled')} aria-disabled>
          <ForgeaxIcon name="unlock" size={15} />
        </button>
      </div>

      {/* ── Toolbar ──────────────────────────────────────────────── */}
      <div className="dp-toolbar">
        <div className="dp-search">
          <span className="mag"><ForgeaxIcon name="search" size={13} /></span>
          <input
            data-testid="insp-search"
            value={query}
            placeholder={t('editor.inspector.searchPlaceholder')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="t-btn" data-testid="insp-settings" title={t('editor.inspector.displaySettings')}>
              <ForgeaxIcon name="sliders" size={15} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="fx-insp-menu">
            <DropdownMenuLabel className="fx-insp-menu-title">{t('editor.inspector.displaySettings')}</DropdownMenuLabel>
            <DropdownMenuItem className="fx-insp-menu-item" data-testid="insp-modified-only" disabled>
              <span className="mi"><ForgeaxIcon name="filter" size={14} /></span>{t('editor.inspector.showModifiedOnly')}
            </DropdownMenuItem>
            <DropdownMenuItem className="fx-insp-menu-item" data-testid="insp-expand-all" onSelect={() => setCollapsed(new Set())}>
              <span className="mi"><ForgeaxIcon name="expand" size={14} /></span>{t('editor.inspector.expandAll')}
            </DropdownMenuItem>
            <DropdownMenuItem className="fx-insp-menu-item" data-testid="insp-collapse-all" onSelect={() => setCollapsed(new Set(bodyComponents.map(([c]) => c)))}>
              <span className="mi"><ForgeaxIcon name="collapse" size={14} /></span>{t('editor.inspector.collapseAll')}
            </DropdownMenuItem>
            <DropdownMenuSeparator className="fx-insp-menu-sep" />
            <DropdownMenuItem
              className="fx-insp-menu-item"
              data-testid="insp-reset-all"
              onSelect={() => {
                const commands: EditorOp[] = bodyComponents
                  .filter(([comp]) => getComponentSchema(comp) !== undefined)
                  .map(([comp]) => ({ kind: 'setComponent', entity: sel, component: comp, patch: defaultComponentData(comp) }));
                if (commands.length) gateway.dispatch({ kind: 'transaction', label: `reset all on #${sel}`, commands });
              }}
            >
              <span className="mi"><ForgeaxIcon name="reset" size={14} /></span>{t('editor.inspector.resetAll')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* ── Components strip + Add ────────────────────────────────── */}
      <div className="dp-comp">
        <div className="ch">
          <span className="lbl">{t('editor.inspector.components')}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="add" data-testid="insp-add-comp" disabled={missingComponents.length === 0}>
                <ForgeaxIcon name="plus" size={12} />{t('editor.inspector.addComponent')}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="fx-insp-menu">
              <DropdownMenuLabel className="fx-insp-menu-title">{t('editor.inspector.addComponent')}</DropdownMenuLabel>
              {missingComponents.map((c) => (
                <DropdownMenuItem
                  key={c}
                  className="fx-insp-menu-item"
                  data-testid={`insp-add-${c}`}
                  onSelect={() => gateway.dispatch({ kind: 'addComponent', entity: sel, component: c, value: defaultComponentData(c) })}
                >
                  <span className="mi"><ForgeaxIcon name={compIcon(c)} size={14} /></span>{c}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {bodyComponents.map(([comp]) => (
          <div
            key={comp}
            role="button"
            tabIndex={0}
            className="comp-row"
            data-testid={`insp-comprow-${comp}`}
            onClick={() => revealComp(comp)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); revealComp(comp); } }}
          >
            <span className="ci"><ForgeaxIcon name={compIcon(comp)} size={13} /></span>
            <span className="comp-name">{comp}</span>
            <button
              type="button"
              className="comp-del"
              data-testid={`insp-comprow-remove-${comp}`}
              title="remove component"
              onClick={(e) => { e.stopPropagation(); gateway.dispatch({ kind: 'removeComponent', entity: sel, component: comp }); }}
            >
              <ForgeaxIcon name="trash" size={12} />
            </button>
          </div>
        ))}
      </div>

      {/* ── Body: Hierarchy + per-component categories ────────────── */}
      <div className="dp-body">
        {!searching && (
          <div className="cat dim-all">
            <div className="cat-head">
              <span className="car"><ForgeaxIcon name="layers" size={13} /></span>
              <span className="ct">{t('editor.inspector.hierarchy')}</span>
            </div>
            <div className="cat-fields">
              <div className="f-row">
                <span className="f-name">{t('editor.inspector.parent')}</span>
                <span className="f-val">
                  <span className="ddc">
                    <Select
                      value={nodeParent == null ? '__root__' : String(nodeParent)}
                      onValueChange={(v) => gateway.dispatch({ kind: 'reparent', entity: sel, parent: v === '__root__' ? null : Number(v) })}
                    >
                      <SelectTrigger className="fx-insp-select" data-testid="insp-parent">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="fx-insp-menu">
                        <SelectItem value="__root__" className="fx-insp-opt">(root)</SelectItem>
                        {parentOptions.map((id) => (
                          <SelectItem key={id} value={String(id)} className="fx-insp-opt">{entName(gateway.activeWorld, id)} #{id}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </span>
                </span>
              </div>
            </div>
          </div>
        )}

        {bodyComponents.map(([comp, value]) => {
          if (!compMatches(comp)) return null;
          const isCollapsed = collapsed.has(comp) && !searching;
          const hasSchema = getComponentSchema(comp) !== undefined;
          const defaults = hasSchema ? (defaultComponentData(comp) as Record<string, unknown>) : {};
          return (
            <div className={`cat ${compDim(comp)}${isCollapsed ? ' collapsed' : ''}`} key={comp} ref={(el) => { catRefs.current[comp] = el; }}>
              <div
                className="cat-head"
                data-testid={`insp-comp-toggle-${comp}`}
                onClick={() => toggleComp(comp)}
                onContextMenu={(e) => showContextMenu(e, [
                  { label: t('editor.inspector.refToChat'), onClick: () => requestRefComponent(sel, comp, value) },
                  { label: t('editor.inspector.copyJson'), onClick: () => { void navigator.clipboard?.writeText(JSON.stringify({ [comp]: value }, null, 2)); } },
                ])}
              >
                <span className="car"><ForgeaxIcon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={12} /></span>
                <span className="ct">{comp}</span>
                <span className="cacts">
                  <button
                    type="button"
                    className="cact"
                    title="copy this component as JSON (for AI / tool-call patch)"
                    data-testid={`insp-copy-${comp}`}
                    onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(JSON.stringify({ [comp]: value }, null, 2)); }}
                  >
                    <ForgeaxIcon name="copy" size={13} />
                  </button>
                  {hasSchema && (
                    <button
                      type="button"
                      className="cact"
                      title="reset to default values"
                      data-testid={`insp-reset-${comp}`}
                      onClick={(e) => { e.stopPropagation(); gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: defaultComponentData(comp) }); }}
                    >
                      <ForgeaxIcon name="reset" size={13} />
                    </button>
                  )}
                  {comp !== 'Name' && (
                    <button
                      type="button"
                      className="cact danger"
                      title="remove component"
                      data-testid={`insp-remove-${comp}`}
                      onClick={(e) => { e.stopPropagation(); gateway.dispatch({ kind: 'removeComponent', entity: sel, component: comp }); }}
                    >
                      <ForgeaxIcon name="trash" size={13} />
                    </button>
                  )}
                </span>
              </div>
              {isCollapsed ? null : getComponentSchema(comp)?.bespoke ? (
                <div className="bespoke-hint" data-testid={`insp-bespoke-${comp}`}>
                  <span className="bespoke-icon"><ForgeaxIcon name="hexagon" size={13} /></span>
                  <span>{getComponentSchema(comp)!.bespoke!.hint}</span>
                </div>
              ) : typeof value === 'object' && value !== null ? (
                <div className="cat-fields">
                  {(() => {
                    const data = value as Record<string, unknown>;
                    const keys = mergedFieldKeys(comp, data).filter((k) => fieldVisible(comp, fieldSchema(comp, k), data) && fieldMatches(comp, k));
                    const out: ReactNode[] = [];

                    const resetBtn = (key: string, cur: unknown, dispatchReset: () => void): ReactNode => {
                      const def = defaults[key];
                      const dirty = hasSchema && def !== undefined && !fieldEquals(cur, def);
                      return (
                        <button
                          type="button"
                          className={`reset${dirty ? '' : ' hidden'}`}
                          data-testid={`insp-${comp}-${key}-reset`}
                          title="reset to default"
                          tabIndex={dirty ? 0 : -1}
                          onClick={dirty ? dispatchReset : undefined}
                        >
                          <ForgeaxIcon name="reset" size={11} />
                        </button>
                      );
                    };

                    // vec fields (skip Transform.quat — the euler overlay is its surface).
                    for (const f of getComponentSchema(comp)?.fields ?? []) {
                      if (f.type !== 'vec') continue;
                      if (comp === 'Transform' && f.key === 'quat') continue;
                      if (!fieldMatches(comp, f.key)) continue;
                      const vec = readVec(f, data[f.key]);
                      if (f.widget === 'color') {
                        const hex = linearToSrgbHex(vec);
                        out.push(
                          <div className="f-row" data-testid={`insp-field-${comp}-${f.key}`} key={`__vec_${f.key}`}>
                            <span className="f-name" title={f.tooltip}>{f.key}</span>
                            <span className="f-val">
                              <input
                                type="color"
                                className="swatch"
                                data-testid={`insp-${comp}-${f.key}`}
                                value={hex}
                                onChange={(e) => gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: srgbHexToLinear(e.target.value) } })}
                              />
                              <span className="hexval" data-testid={`insp-${comp}-${f.key}-hex`}>{hex}</span>
                              {resetBtn(f.key, data[f.key], () => gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: defaults[f.key] } }))}
                            </span>
                          </div>,
                        );
                        continue;
                      }
                      const labels = vecAxisLabels(f);
                      out.push(
                        <div className="f-row" data-testid={`insp-${comp}-${f.key}`} key={`__vec_${f.key}`}>
                          <span className="f-name" title={f.tooltip}>{f.key}</span>
                          <span className="f-val vec">
                            {vec.map((axVal, i) => (
                              <span className={`vcell ${labels[i] ?? i}`} key={i}>
                                <ScrubInput
                                  key={`${sel}:${comp}:${f.key}:${i}`}
                                  value={axVal}
                                  fs={{ key: f.key, type: 'number', step: f.step, tooltip: f.tooltip }}
                                  testid={`insp-${comp}-${f.key}-${i}`}
                                  className="box-i"
                                  onCommit={(val) => {
                                    const next = readVec(f, data[f.key]);
                                    next[i] = val;
                                    gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: next } });
                                  }}
                                />
                              </span>
                            ))}
                            {resetBtn(f.key, data[f.key], () => gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: defaults[f.key] } }))}
                          </span>
                        </div>,
                      );
                    }

                    // Transform euler overlay (scheme B): edit degrees, write quat.
                    if (comp === 'Transform' && fieldMatches(comp, 'rotation')) {
                      const commitEuler = (key: string, deg: number) => {
                        const next = { ...euler, [key]: deg };
                        setEuler(next);
                        const [qx, qy, qz, qw] = eulerToQuat(next.rotX, next.rotY, next.rotZ);
                        gateway.dispatch({ kind: 'setComponent', entity: sel, component: 'Transform', patch: { quat: [qx, qy, qz, qw] } });
                      };
                      const ROTATIONS = [
                        { key: 'rotX', axis: 'x', tooltip: 'rotation around X (degrees)', testid: 'insp-Transform-rotX' },
                        { key: 'rotY', axis: 'y', tooltip: 'rotation around Y (degrees)', testid: 'insp-Transform-rotY' },
                        { key: 'rotZ', axis: 'z', tooltip: 'rotation around Z (degrees)', testid: 'insp-Transform-rotZ' },
                      ];
                      out.push(
                        <div className="f-row" data-testid="insp-Transform-rot-vec3" key="__rot">
                          <span className="f-name">rotation</span>
                          <span className="f-val vec">
                            {ROTATIONS.map((r) => (
                              <span className={`vcell ${r.axis}`} key={r.key}>
                                <ScrubInput
                                  key={`${sel}:${r.key}`}
                                  value={euler[r.key as keyof typeof euler]}
                                  fs={{ key: r.key, type: 'number', step: 1, tooltip: r.tooltip }}
                                  testid={r.testid}
                                  className="box-i"
                                  onCommit={(val) => commitEuler(r.key, val)}
                                />
                              </span>
                            ))}
                            {(() => {
                              const rotDirty = Math.abs(euler.rotX) > 1e-4 || Math.abs(euler.rotY) > 1e-4 || Math.abs(euler.rotZ) > 1e-4;
                              return (
                                <button
                                  type="button"
                                  className={`reset${rotDirty ? '' : ' hidden'}`}
                                  data-testid="insp-Transform-rotation-reset"
                                  title="reset rotation to default"
                                  tabIndex={rotDirty ? 0 : -1}
                                  onClick={rotDirty ? () => { setEuler({ rotX: 0, rotY: 0, rotZ: 0 }); gateway.dispatch({ kind: 'setComponent', entity: sel, component: 'Transform', patch: { quat: [0, 0, 0, 1] } }); } : undefined}
                                >
                                  <ForgeaxIcon name="reset" size={11} />
                                </button>
                              );
                            })()}
                          </span>
                        </div>,
                      );
                    }

                    // array<asset> fields (e.g. MeshRenderer.materials) as slots.
                    for (const f of getComponentSchema(comp)?.fields ?? []) {
                      if (f.type !== 'asset') continue;
                      if (!fieldMatches(comp, f.key)) continue;
                      const arrVal = data[f.key];
                      if (!Array.isArray(arrVal) && !ArrayBuffer.isView(arrVal)) continue;
                      const items = Array.from(arrVal as ArrayLike<unknown>);
                      const arrType = expectedAssetType(comp, f.key) ?? 'MaterialAsset';
                      const submeshCount = comp === 'MeshRenderer' && f.key === 'materials'
                        ? meshSubmeshCount(nodeComponents)
                        : null;
                      const locked = submeshCount !== null;
                      const slotCount = locked ? submeshCount! : items.length;
                      const mismatch = locked && items.length !== slotCount;
                      const resizedTo = (n: number): number[] => {
                        const next: number[] = [];
                        for (let k = 0; k < n; k++) next.push(typeof items[k] === 'number' ? (items[k] as number) : 0);
                        return next;
                      };
                      const pickSlot = (i: number, currentGuid?: string) => {
                        if (sel === null) return;
                        if (locked) {
                          if (items.length !== slotCount) {
                            gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: resizedTo(slotCount) } });
                          }
                          setPicker({ comp, field: f.key, assetType: arrType, slot: i, currentGuid });
                          return;
                        }
                        const at = items.length;
                        gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: [...items, 0] } });
                        setPicker({ comp, field: f.key, assetType: arrType, slot: at });
                      };
                      const rowCount = locked ? slotCount : Math.max(items.length, 1);
                      out.push(
                        <div className="f-row" key={`__arr_${f.key}`} data-testid={`insp-${comp}-${f.key}-array`} style={{ alignItems: 'flex-start' }}>
                          <span className="f-name" title={f.tooltip}>
                            {f.key}
                            <span className="asset-dot">{items.some((x) => typeof x === 'number' && x > 0) ? <ForgeaxIcon name="dot" size={9} /> : <ForgeaxIcon name="hexagon" size={9} />}</span>
                          </span>
                          <span className="f-val">
                            <div className="asset-slots">
                              {mismatch && (
                                <button
                                  type="button"
                                  className="asset-fix"
                                  data-testid={`insp-${comp}-${f.key}-fix`}
                                  onClick={() => gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: resizedTo(slotCount) } })}
                                  title={`materials (${items.length}) must equal submeshes (${slotCount}) — click to fix`}
                                >
                                  <ForgeaxIcon name="flag" size={11} /> {items.length} / {slotCount} submeshes — click to fix
                                </button>
                              )}
                              {Array.from({ length: rowCount }, (_unused, i) => {
                                const virtual = !locked && i >= items.length;
                                const rawItem = items[i];
                                const handleNum = typeof rawItem === 'number' ? rawItem : 0;
                                const desc = handleNum > 0 ? gateway.describeAsset(handleNum) : null;
                                const matName = desc?.ok ? ((desc.name && desc.name.trim()) || (desc.guid ? desc.guid.slice(0, 8) : '')) : '';
                                const slotGuid = desc?.ok ? desc.guid : undefined;
                                const slotKind = desc?.ok ? desc.kind : undefined;
                                const slotMeta = desc?.ok ? desc.meta : undefined;
                                return (
                                  <div
                                    key={i}
                                    className="asset-f"
                                    role="button"
                                    tabIndex={0}
                                    data-testid={`insp-${comp}-${f.key}-slot-${i}`}
                                    title={handleNum > 0 ? `${matName} — click to change` : `slot ${i}: click to browse or drop a ${arrType}`}
                                    onClick={() => pickSlot(i, slotGuid)}
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickSlot(i, slotGuid); } }}
                                    onDragEnter={(e) => { e.preventDefault(); e.currentTarget.classList.add('drop-hot'); }}
                                    onDragLeave={(e) => e.currentTarget.classList.remove('drop-hot')}
                                    onDrop={(e) => {
                                      e.preventDefault();
                                      e.currentTarget.classList.remove('drop-hot');
                                      const assetJson = e.dataTransfer.getData('application/x-forgeax-asset');
                                      if (!assetJson) return;
                                      let ref: { guid?: string; kind?: string } = {};
                                      try { ref = JSON.parse(assetJson); } catch { return; }
                                      if (!ref.guid) return;
                                      if (locked && items.length !== slotCount) {
                                        gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: resizedTo(slotCount) } });
                                      } else if (virtual) {
                                        gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: [...items, 0] } });
                                      }
                                      gateway.dispatch({
                                        kind: 'bindAssetRef',
                                        entity: sel,
                                        component: comp,
                                        field: f.key,
                                        assetType: ref.kind ?? 'MaterialAsset',
                                        guids: [ref.guid],
                                        slot: virtual ? items.length : i,
                                      });
                                    }}
                                    onDragOver={(e) => e.preventDefault()}
                                  >
                                    <AssetPreview bound={handleNum > 0} kind={slotKind} meta={slotMeta} guid={slotGuid ?? undefined} />
                                    <span className={`an${handleNum > 0 ? '' : ' empty'}`} title={matName}>
                                      {handleNum > 0 ? matName : (locked ? `slot ${i} — browse ${arrType}` : `click / drop ${arrType}`)}
                                    </span>
                                    <span className="abtn">
                                      {locked && handleNum > 0 && (
                                        <button type="button" title="clear slot" onClick={(e) => {
                                          e.stopPropagation();
                                          gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: resizedTo(slotCount).map((h, j) => (j === i ? 0 : h)) } });
                                        }}><ForgeaxIcon name="x" size={12} /></button>
                                      )}
                                      {!locked && !virtual && (
                                        <button type="button" title="remove slot" onClick={(e) => {
                                          e.stopPropagation();
                                          const next = items.filter((_, j) => j !== i);
                                          gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: next } });
                                        }}><ForgeaxIcon name="x" size={12} /></button>
                                      )}
                                    </span>
                                  </div>
                                );
                              })}
                              {locked ? (
                                <div className="asset-slotnote">{slotCount} slot{slotCount === 1 ? '' : 's'} — matches mesh submeshes</div>
                              ) : (
                                <div className="asset-actions">
                                  <button type="button" className="fbtn" data-testid={`insp-${comp}-${f.key}-pick`} onClick={() => pickSlot(items.length)}>
                                    <ForgeaxIcon name="folder" size={11} /> pick
                                  </button>
                                  <button type="button" className="fbtn" onClick={() => gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: [...items, 0] } })}>
                                    <ForgeaxIcon name="plus" size={11} /> slot
                                  </button>
                                </div>
                              )}
                            </div>
                          </span>
                        </div>,
                      );
                    }

                    // scalar fields
                    for (const k of keys) {
                      const v = data[k];
                      if (fieldSchema(comp, k)?.type === 'vec') continue;
                      if (v !== null && typeof v === 'object') continue;
                      const fs = fieldSchema(comp, k);
                      const setField = (val: unknown) => gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [k]: val } });
                      const type = fs?.type ?? (typeof v === 'number' ? 'number' : 'string');
                      const reset = resetBtn(k, v, () => setField(defaults[k]));
                      if (type === 'number') {
                        const liveNum = fieldPrev && fieldPrev.id === sel && fieldPrev.key === `${comp}.${k}` ? fieldPrev.value : (typeof v === 'number' ? v : 0);
                        const ranged = fs?.min !== undefined && fs?.max !== undefined;
                        out.push(
                          <div className="f-row" key={`${sel}:${comp}:${k}`} data-testid={`insp-field-${comp}-${k}`}>
                            <span className="f-name" title={fs?.tooltip}>{k}</span>
                            <span className="f-val">
                              {ranged && (
                                <input type="range" min={fs!.min} max={fs!.max} step={fs?.step ?? 0.01} data-testid={`insp-${comp}-${k}-slider`} value={liveNum} onChange={(e) => setField(Number(e.target.value))} />
                              )}
                              <ScrubInput value={liveNum} fs={fs} testid={`insp-${comp}-${k}`} className="box-i num" onCommit={setField} />
                              {reset}
                            </span>
                          </div>,
                        );
                        continue;
                      }
                      const strVal = v === undefined || v === null ? '' : String(v);
                      // Asset (shared<T>) fields store a numeric handle where 0 = unbound.
                      // Never surface the raw handle ("0" / "1025"): only a positive handle
                      // (or a non-empty guid string) counts as "bound".
                      const assetBound = type === 'asset' ? (typeof v === 'number' ? v > 0 : strVal !== '') : false;
                      out.push(
                        <div className="f-row" key={k} data-testid={`insp-field-${comp}-${k}`}>
                          <span className="f-name" title={fs?.tooltip}>
                            {k}
                            {type === 'asset' && <span className="asset-dot" data-testid={`insp-${comp}-${k}-dot`}>{assetBound ? <ForgeaxIcon name="dot" size={9} /> : <ForgeaxIcon name="hexagon" size={9} />}</span>}
                          </span>
                          <span className="f-val">
                            {type === 'bool' ? (
                              <BoolCheckbox checked={v === true} testid={`insp-${comp}-${k}`} onToggle={(c) => setField(c)} />
                            ) : type === 'color' ? (
                              <>
                                <input type="color" className="swatch" data-testid={`insp-${comp}-${k}`} value={strVal || '#cccccc'} onChange={(e) => setField(e.target.value)} />
                                <span className="hexval" data-testid={`insp-${comp}-${k}-hex`}>{strVal || '#cccccc'}</span>
                              </>
                            ) : type === 'enum' ? (
                              <EnumSelect value={strVal} options={fs?.options ?? []} testid={`insp-${comp}-${k}`} onChange={setField} />
                            ) : type === 'asset' ? (
                              (() => {
                                const scalarType = expectedAssetType(comp, k) ?? 'MeshAsset';
                                const curDesc = typeof v === 'number' && v > 0 ? gateway.describeAsset(v) : null;
                                const curGuid = curDesc?.ok ? curDesc.guid : undefined;
                                const curKind = curDesc?.ok ? curDesc.kind : undefined;
                                const curMeta = curDesc?.ok ? curDesc.meta : undefined;
                                // Numeric handle → show the resolved asset name (never the
                                // raw #handle); fall back to a short guid, else empty so the
                                // placeholder shows. unbound (0) → empty.
                                const assetName = curDesc?.ok ? ((curDesc.name && curDesc.name.trim()) || (curDesc.guid ? curDesc.guid.slice(0, 8) : '')) : '';
                                const display = typeof v === 'number' ? (v > 0 ? assetName : '') : strVal;
                                return (
                                  <div
                                    className="asset-f"
                                    onDragEnter={(e) => { e.preventDefault(); e.currentTarget.classList.add('drop-hot'); }}
                                    onDragLeave={(e) => e.currentTarget.classList.remove('drop-hot')}
                                    onDragOver={(e) => e.preventDefault()}
                                    onDrop={(e) => {
                                      e.preventDefault();
                                      e.currentTarget.classList.remove('drop-hot');
                                      const assetJson = e.dataTransfer.getData('application/x-forgeax-asset');
                                      if (!assetJson) return;
                                      try {
                                        const ref = JSON.parse(assetJson);
                                        if (ref.guid) {
                                          gateway.dispatch({ kind: 'bindAssetRef', entity: sel, component: comp, field: k, assetType: ref.kind ?? 'MeshAsset', guids: [ref.guid] });
                                        }
                                      } catch { /* noop */ }
                                    }}
                                  >
                                    <AssetPreview bound={assetBound} kind={curKind} meta={curMeta} guid={curGuid ?? undefined} />
                                    <input
                                      className="an"
                                      style={{ background: 'transparent', border: 'none', outline: 'none' }}
                                      data-testid={`insp-${comp}-${k}`}
                                      placeholder={`drop / paste ${scalarType} uuid`}
                                      value={display}
                                      readOnly={typeof v === 'number' && v > 0}
                                      onChange={(e) => setField(e.target.value)}
                                    />
                                    <span className="abtn">
                                      <button type="button" data-testid={`insp-${comp}-${k}-browse`} title={`browse ${scalarType}`} onClick={() => setPicker({ comp, field: k, assetType: scalarType, currentGuid: curGuid })}>
                                        <ForgeaxIcon name="folder" size={12} />
                                      </button>
                                      {assetBound && (
                                        <button type="button" data-testid={`insp-${comp}-${k}-clear`} title="unbind this asset" onClick={() => setField(typeof v === 'number' ? 0 : '')}>
                                          <ForgeaxIcon name="x" size={12} />
                                        </button>
                                      )}
                                    </span>
                                  </div>
                                );
                              })()
                            ) : (
                              <input className="box-i txt" data-testid={`insp-${comp}-${k}`} value={strVal} onChange={(e) => setField(e.target.value)} />
                            )}
                            {type !== 'asset' && reset}
                          </span>
                        </div>,
                      );
                    }
                    return out;
                  })()}
                </div>
              ) : null}
            </div>
          );
        })}

        {searching && !anyMatch && <div className="no-match">{t('editor.inspector.noMatch', { query })}</div>}
      </div>

      {picker && (
        <AssetPicker
          assetType={picker.assetType}
          currentGuid={picker.currentGuid}
          onPick={bindPicked}
          onClear={clearPicked}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
