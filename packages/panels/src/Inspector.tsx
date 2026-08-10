import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { showContextMenu } from '@forgeax/editor-core';
import { clampToField, defaultComponentData, eulerToQuat, fieldSchema, fieldVisible, getComponentSchema, isComponentHidden, listComponentSchemas, planArrayEdit, quatToEuler, type ArrayEditAction, type FieldSchema } from '@forgeax/editor-core';
// Shared component-name localization (SSOT with the hierarchy type column/filter):
// engine component names → per-name i18n label, raw English fallback for unmapped.
import { componentTypeLabel } from './hierarchy-state';
// M3 (AC-03, plan-strategy §2 D-6): mutations + view-intent ops go through the
// one gateway door — gateway.dispatch({ kind, … }) — replacing the direct setters
// (setSelectionMany / requestFrame) and the origin-less `dispatch` wrapper.
import { createInspectorFieldSelector, dispatchActiveEditorOperation, gateway, getActiveRuntimeUiGraph, getViewportRuntimeClientSnapshot, queryViewportRuntimeProjection, requestRefComponent, subscribeViewportRuntimeClient, useDocVersion, useFieldPreview, useSelection, useSelectionList } from '@forgeax/editor-core';
import { entExists, entName, entComponent, entComponents } from '@forgeax/editor-core';
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
import { getBespokeEditor } from './bespoke-editors';
import { inspectorFieldRendererKind, isUnsupportedRendererKind, isVectorRendererKind } from './inspector-field-shape';
import './inspector.css';
import { getOperationProjectionSource } from './operations/run-view-model';
import type { InspectorRuntimeProjection } from './inspector-runtime-projection';

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

type LiveFieldBinding = {
  entity: EntityHandle;
  component: string;
  field: string;
  read: (world: unknown) => unknown;
};

// DCC-style scrub-able number box. A single click focuses the box for typing; a
// horizontal drag (past a small threshold) scrubs the value with a LOCAL preview
// and commits once on release (one undo step). Typing still commits on blur/Enter.
// Playwright's .fill()+.blur() path (used by super-four e2e on insp-Transform-pos-*)
// is unaffected — it focuses+types+blurs and never crosses the drag threshold.
function ScrubInput({
  value, fs, testid, className, title, onCommit, liveField, axis,
}: {
  value: number;
  fs?: FieldSchema | undefined;
  testid: string;
  className: string;
  title?: string | undefined;
  onCommit: (n: number) => void;
  liveField?: LiveFieldBinding | undefined;
  axis?: number | undefined;
}) {
  const [drag, setDrag] = useState<{ ox: number; base: number; v: number } | null>(null);
  const start = useRef<{ x: number } | null>(null);
  const step = fs?.step ?? 0.1;
  const liveValue = useLiveFieldNumber(value, liveField, axis);
  const shown = drag ? drag.v : liveValue;
  const isScrubbing = drag !== null;
  const isFocused = document.activeElement?.getAttribute('data-testid') === testid;
  const generation = `${liveField?.entity ?? 'rotation'}:${getActiveRuntimeUiGraph()?.stats().worldGeneration ?? 0}`;
  const num = useNumberDraft(shown, fs, onCommit, generation);
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
        data-focused={isFocused}
        data-scrubbing={isScrubbing}
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
  const packPath = guid ? (gateway.assetCatalog().find((e) => e.guid === guid)?.packageUrl ?? '') : '';
  return <AssetThumbnail kind={kind} payload={meta} packPath={packPath} size={15} />;
}

// enum widget — editor-ui Select (Radix) styled compact to sit in a field row.
// The listbox is portaled and picks up the shared `.fx-insp-menu` panel skin.
// Labels are presentation; the numeric value is the engine-owned SSOT payload.
function EnumSelect({ value, options, testid, onChange, liveField }: {
  value: number;
  options: ReadonlyArray<{ label: string; value: number }>;
  testid: string;
  onChange: (v: number) => void;
  liveField?: LiveFieldBinding | undefined;
}) {
  const liveValue = useLiveFieldNumber(value, liveField, undefined);
  const current = String(Number.isFinite(liveValue) ? liveValue : options[0]?.value ?? '');
  return (
    <span className="ddc">
      <Select value={current} onValueChange={(raw) => {
        const option = options.find((candidate) => String(candidate.value) === raw);
        if (option !== undefined) onChange(option.value);
      }}>
        <SelectTrigger className="fx-insp-select" data-testid={testid}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="fx-insp-menu">
          {options.map((opt) => (
            <SelectItem key={opt.label} value={String(opt.value)} className="fx-insp-opt">{opt.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  );
}

// Optional scalar/entity field. Empty text is the producer-owned null/unset
// sentinel; a present numeric value is dispatched as the live EntityHandle (or
// scalar number), never as a panel-local id. Enter and blur share one commit
// path, while the clear button gives reset/unset an explicit keyboard target.
function OptionalInput({ value, fs, testid, onCommit, liveField }: {
  value: unknown;
  fs?: FieldSchema | undefined;
  testid: string;
  onCommit: (value: unknown) => void;
  liveField?: LiveFieldBinding | undefined;
}) {
  const liveValue = useLiveFieldValue(value, liveField);
  const [draft, setDraft] = useState(liveValue === null || liveValue === undefined ? '' : String(liveValue));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(liveValue === null || liveValue === undefined ? '' : String(liveValue));
    setInvalid(false);
  }, [liveValue]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      setInvalid(false);
      onCommit(null);
      return;
    }
    if (fs?.type === 'number') {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        setInvalid(true);
        return;
      }
      setInvalid(false);
      onCommit(parsed);
      return;
    }
    setInvalid(false);
    onCommit(trimmed);
  };

  return (
    <span className="optfield">
      <input
        type="text"
        inputMode={fs?.type === 'number' ? 'decimal' : 'text'}
        className="box-i txt optional"
        data-testid={testid}
        value={draft}
        placeholder="unset"
        aria-label={`${testid} optional value`}
        aria-invalid={invalid || undefined}
        title={fs?.tooltip ?? 'empty = unset'}
        onChange={(e) => { setDraft(e.target.value); setInvalid(false); }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLInputElement).blur(); }
          else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(liveValue === null || liveValue === undefined ? '' : String(liveValue));
            setInvalid(false);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
      />
      <button
        type="button"
        className="fbtn opt-clear"
        data-testid={`${testid}-clear`}
        title="unset"
        aria-label="unset"
        onPointerDown={(e) => {
          e.preventDefault();
          setDraft('');
          setInvalid(false);
          onCommit(null);
        }}
      >
        unset
      </button>
      {invalid && <span className="unsupported-field" role="status">invalid value</span>}
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
// Union of a component's schema-declared fields with whatever keys the instance
// actually carries (schema order first) → the inspector surfaces the FULL
// component shape (e.g. empty asset slots) even when the data omits them.
function mergedFieldKeys(comp: string, value: Record<string, unknown>): string[] {
  const schemaKeys = getComponentSchema(comp)?.fields.map((f) => f.key) ?? [];
  return [...new Set([...schemaKeys, ...Object.keys(value)])];
}

function UnsupportedField({ component, field, kind }: { component: string; field: string; kind: string }): ReactNode {
  const label = kind === 'unsupported' ? 'unknown' : kind;
  return (
    <div className="f-row" data-testid={`insp-field-${component}-${field}`}>
      <span className="f-name">{field}</span>
      <span className="f-val">
        <span className="unsupported-field" role="status" data-testid={`insp-${component}-${field}-unsupported`}>
          Unsupported field shape: {label}
        </span>
      </span>
    </div>
  );
}

function ArrayFieldEditor({
  entity,
  component,
  field,
  fs,
  value,
  data,
  readOnly,
  dispatch,
  reset,
}: {
  entity: EntityHandle;
  component: string;
  field: string;
  fs: FieldSchema;
  value: unknown;
  data: Record<string, unknown>;
  readOnly: boolean;
  dispatch: (op: EditorOp) => void;
  reset: ReactNode;
}): ReactNode {
  const [error, setError] = useState<string | null>(null);
  const items = Array.isArray(value) ? value : ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<unknown>) : [];
  const elementType = fs.arrayMeta?.elementType ?? 'f32';

  const apply = (action: ArrayEditAction, index?: number, toIndex?: number, nextValue?: unknown) => {
    const plan = planArrayEdit({
      component,
      field,
      action,
      ...(index === undefined ? {} : { index }),
      ...(toIndex === undefined ? {} : { toIndex }),
      ...(nextValue === undefined ? {} : { value: nextValue }),
    }, data);
    if (!plan.ok) {
      setError(plan.hint);
      return;
    }
    setError(null);
    dispatch({ kind: 'setComponent', entity, component, patch: plan.patch });
  };

  return (
    <div className="array-editor" data-testid={`insp-${component}-${field}-array`}>
      {items.length === 0 && <span className="asset-slotnote">empty</span>}
      {items.map((item, index) => {
        const numeric = typeof item === 'number' ? item : Number(item ?? 0);
        const input = elementType === 'bool' ? (
          <input
            type="checkbox"
            checked={item === true}
            disabled={readOnly}
            data-testid={`insp-${component}-${field}-item-${index}`}
            onChange={(event) => apply('update', index, undefined, event.target.checked)}
          />
        ) : (
          <input
            className="box-i num"
            type={elementType === 'string' ? 'text' : 'number'}
            defaultValue={elementType === 'string' ? String(item ?? '') : numeric}
            disabled={readOnly}
            data-testid={`insp-${component}-${field}-item-${index}`}
            onBlur={(event) => apply('update', index, undefined, elementType === 'string' ? event.currentTarget.value : Number(event.currentTarget.value))}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          />
        );
        return (
          <div className="array-item" key={`${component}.${field}:${index}:${String(item)}`}>
            <span className="array-index">{index}</span>
            {input}
            <span className="abtn">
              <button type="button" title="move up" disabled={readOnly || index === 0} onClick={() => apply('reorder', index, index - 1)}>↑</button>
              <button type="button" title="move down" disabled={readOnly || index === items.length - 1} onClick={() => apply('reorder', index, index + 1)}>↓</button>
              <button type="button" title="remove item" disabled={readOnly} onClick={() => apply('remove', index)}>×</button>
            </span>
          </div>
        );
      })}
      <div className="asset-actions">
        <button type="button" className="fbtn" disabled={readOnly} data-testid={`insp-${component}-${field}-add`} onClick={() => apply('add')}>
          <ForgeaxIcon name="plus" size={11} /> item
        </button>
        {reset}
      </div>
      {error !== null && <span className="unsupported-field" role="status">{error}</span>}
    </div>
  );
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

function sameFieldValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  const av = ArrayBuffer.isView(a) ? Array.from(a as unknown as ArrayLike<unknown>) : a;
  const bv = ArrayBuffer.isView(b) ? Array.from(b as unknown as ArrayLike<unknown>) : b;
  if (Array.isArray(av) && Array.isArray(bv)) {
    return av.length === bv.length && av.every((value, index) => sameFieldValue(value, bv[index]));
  }
  if (typeof av === 'object' && av !== null && typeof bv === 'object' && bv !== null) {
    const ak = Object.keys(av as Record<string, unknown>);
    const bk = Object.keys(bv as Record<string, unknown>);
    return ak.length === bk.length && ak.every((key) => sameFieldValue(
      (av as Record<string, unknown>)[key],
      (bv as Record<string, unknown>)[key],
    ));
  }
  return false;
}

function componentPresence(ids: EntityHandle[]): Map<string, number> {
  const presence = new Map<string, number>();
  for (const id of ids) {
    for (const component of Object.keys(entComponents(gateway.activeWorld, id))) {
      presence.set(component, (presence.get(component) ?? 0) + 1);
    }
  }
  return presence;
}

function batchFieldValues(ids: EntityHandle[], component: string, field: string): unknown[] {
  return ids.map((id) => {
    const result = entComponent(gateway.activeWorld, id, component);
    return result.ok ? (result.value as Record<string, unknown>)[field] : undefined;
  });
}

function isMixed(values: unknown[]): boolean {
  return values.length > 1 && values.slice(1).some((value) => !sameFieldValue(value, values[0]));
}

// Multi-select batch editor: one edit fans out to all selected as a single
// transaction → one undo. The primary entity supplies the field layout.
function BatchPanel({ ids }: { ids: EntityHandle[] }) {
  const { t } = useTranslation();
  const primary = ids[ids.length - 1]!;
  const common = commonComponents(ids);
  const presence = componentPresence(ids);
  const partial = [...presence.entries()]
    .filter(([, count]) => count > 0 && count < ids.length)
    .map(([component]) => component)
    .sort();
  const addable = listComponentSchemas()
    .map((schema) => schema.name)
    .filter((component) => !presence.has(component))
    .sort();

  function dispatchBatch(label: string, commands: EditorOp[]): void {
    if (commands.length === 0) return;
    gateway.dispatch({ kind: 'transaction', label, commands });
  }

  function setAll(component: string, key: string, value: unknown) {
    const commands: EditorOp[] = ids.map((id) => ({ kind: 'setComponent', entity: id, component, patch: { [key]: value } }));
    dispatchBatch(`batch ${component}.${key} ×${ids.length}`, commands);
  }

  function addComponentToMissing(component: string): void {
    const commands: EditorOp[] = ids
      .filter((id) => !entComponent(gateway.activeWorld, id, component).ok)
      .map((id) => ({ kind: 'addComponent', entity: id, component, value: defaultComponentData(component) }));
    dispatchBatch(`add ${component} ×${commands.length}`, commands);
  }

  function removeComponentFromAll(component: string): void {
    const commands: EditorOp[] = ids
      .filter((id) => entComponent(gateway.activeWorld, id, component).ok)
      .map((id) => ({ kind: 'removeComponent', entity: id, component }));
    dispatchBatch(`remove ${component} ×${commands.length}`, commands);
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
    dispatchBatch(`align ${axis} ×${ids.length}`, commands);
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
      <div className="dp-comp" data-testid="batch-component-actions">
        <div className="ch">
          <span className="lbl">{t('editor.inspector.components')}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="add" data-testid="batch-add-component" disabled={addable.length === 0}>
                <ForgeaxIcon name="plus" size={12} />{t('editor.inspector.addComponent')}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="fx-insp-menu">
              <DropdownMenuLabel className="fx-insp-menu-title">{t('editor.inspector.addComponent')}</DropdownMenuLabel>
              {addable.map((component) => (
                <DropdownMenuItem
                  key={component}
                  className="fx-insp-menu-item"
                  data-testid={`batch-add-${component}`}
                  onSelect={() => addComponentToMissing(component)}
                >
                  <span className="mi"><ForgeaxIcon name={compIcon(component)} size={14} /></span>
                  {componentTypeLabel(component, t)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {partial.length > 0 && (
          <div className="batch-component-list" data-testid="batch-partial-components">
            {partial.map((component) => {
              const count = presence.get(component) ?? 0;
              return (
                <div className="batch-component-row" key={component} data-testid={`batch-partial-${component}`}>
                  <span className="ci"><ForgeaxIcon name={compIcon(component)} size={13} /></span>
                  <span className="comp-name">{componentTypeLabel(component, t)}</span>
                  <span className="batch-component-count">{count}/{ids.length}</span>
                  <button type="button" className="fbtn" data-testid={`batch-add-missing-${component}`} onClick={() => addComponentToMissing(component)}>
                    {t('editor.inspector.addMissing')}
                  </button>
                  <button type="button" className="fbtn" data-testid={`batch-remove-${component}`} onClick={() => removeComponentFromAll(component)}>
                    {t('editor.inspector.removeAll')}
                  </button>
                </div>
              );
            })}
          </div>
        )}
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
                <span className="ct">{componentTypeLabel(comp, t)}</span>
                <button
                  type="button"
                  className="comp-del"
                  data-testid={`batch-remove-common-${comp}`}
                  title={t('editor.inspector.removeAll')}
                  onClick={() => removeComponentFromAll(comp)}
                >
                  <ForgeaxIcon name="trash" size={12} />
                </button>
              </div>
              <div className="cat-fields">
                {(() => {
                  const data = valueR.value as Record<string, unknown>;
              const vecFields = (getComponentSchema(comp)?.fields ?? []).filter((f) => isVectorRendererKind(inspectorFieldRendererKind(f)));
                  const vecKeys = new Set(vecFields.map((f) => f.key));
                  const rows: ReactNode[] = [];
                  for (const f of vecFields) {
                    const vec = readVec(f, data[f.key]);
                    const vecValues = ids.map((id) => {
                      const result = entComponent(gateway.activeWorld, id, comp);
                      return result.ok ? readVec(f, (result.value as Record<string, unknown>)[f.key]) : readVec(f, undefined);
                    });
                    const mixedAxes = vec.map((value, index) => vecValues.some((other) => !sameFieldValue(value, other[index])));
                    if (f.widget === 'color') {
                      const hex = linearToSrgbHex(vec);
                      rows.push(
                        <div className="f-row" data-testid={`batch-field-${comp}-${f.key}`} key={`__vec_${f.key}`}>
                          <span className="f-name" title={f.tooltip}>{f.key}</span>
                          <span className="f-val">
                            {mixedAxes.some(Boolean) && <span className="batch-mixed" data-testid={`batch-${comp}-${f.key}-mixed`}>mixed</span>}
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
                              {mixedAxes[i] && <span className="batch-mixed" data-testid={`batch-${comp}-${f.key}-${i}-mixed`}>mixed</span>}
                              <ScrubInput
                                key={`${primary}:${comp}:${f.key}:${i}`}
                                value={axVal}
                                fs={{ key: f.key, type: 'number', step: f.step, tooltip: f.tooltip }}
                                testid={`batch-${comp}-${f.key}-${i}`}
                                className="box-i"
                                liveField={{ entity: primary, component: comp, field: f.key, read: (world) => {
                                  const result = entComponent(world as Parameters<typeof entComponent>[0], primary, comp);
                                  if (!result.ok) throw new Error(result.error.code);
                                  return result.value[f.key];
                                } }}
                                axis={i}
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
                        const renderer = inspectorFieldRendererKind(fs ?? { type: typeof v === 'number' ? 'number' : 'string' });
                        const mixed = isMixed(batchFieldValues(ids, comp, k));
                        if (isUnsupportedRendererKind(renderer) || renderer === 'array' || renderer === 'asset-ref') {
                          return <UnsupportedField component={comp} field={k} kind={fs?.shape ?? renderer} key={k} />;
                        }
                        return (
                          <div className="f-row" key={k}>
                            <span className="f-name" title={fs?.tooltip}>{k}</span>
                            <span className="f-val">
                              {mixed && <span className="batch-mixed" data-testid={`batch-${comp}-${k}-mixed`}>mixed</span>}
                              {renderer === 'boolean' ? (
                                <BoolCheckbox checked={v === true} testid={`batch-${comp}-${k}`} onToggle={(c) => setAll(comp, k, c)} />
                              ) : renderer === 'enum' ? (
                                <EnumSelect value={Number(v)} options={fs?.enumOptions ?? []} testid={`batch-${comp}-${k}`} onChange={(val) => setAll(comp, k, val)} />
                              ) : renderer === 'optional' ? (
                                <OptionalInput value={v} fs={fs} testid={`batch-${comp}-${k}`} onCommit={(val) => setAll(comp, k, val)} />
                              ) : renderer === 'scalar' ? (
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

/** Project ordinary Inspector field edits onto the engine-owned SceneInstance
 * override op. A selected mount member must never silently become a plain
 * world.set: the same semantic command is what AI callers discover and what
 * scene-pack collection folds into mounts[].overrides[]. */
function projectSceneInstanceMutation(op: EditorOp): EditorOp {
  if (op.kind === 'transaction') {
    const commands = (op as Extract<EditorOp, { kind: 'transaction' }>).commands.map(projectSceneInstanceMutation);
    return { ...op, commands };
  }
  if (op.kind !== 'setComponent') return op;
  const set = op as Extract<EditorOp, { kind: 'setComponent' }>;
  const instance = gateway.sceneInstanceForMember(set.entity as EntityHandle);
  if (!instance.ok) return op;
  const patch = set.patch;
  const fields = Object.entries(patch);
  if (fields.length === 0) return op;
  const commands: EditorOp[] = fields.map(([field, value]) => ({
    kind: 'setSceneOverride',
    root: instance.value.root,
    member: set.entity,
    component: set.component,
    field,
    value,
  }));
  return commands.length === 1
    ? commands[0]!
    : { kind: 'transaction', label: `override ${set.component} ×${commands.length}`, commands };
}

function useLiveFieldValue(
  fallback: unknown,
  field: LiveFieldBinding | undefined,
  axis?: number,
): unknown {
  const graph = getActiveRuntimeUiGraph();
  const holder = useRef<{ graph: typeof graph; key: string; mounted: ReturnType<ReturnType<typeof createInspectorFieldSelector>['mount']> } | null>(null);
  const worldGeneration = graph?.stats().worldGeneration ?? 0;
  const key = field === undefined ? '' : `${field.entity}:${field.component}:${field.field}:${worldGeneration}`;
  if (field !== undefined && graph !== null && (holder.current?.graph !== graph || holder.current.key !== key)) {
    holder.current?.mounted.unsubscribe();
    const selector = createInspectorFieldSelector(graph, {
      entity: field.entity,
      component: field.component,
      field: field.field,
      shape: { kind: axis === undefined ? 'scalar' : 'array' },
      read: field.read,
    });
    holder.current = { graph, key, mounted: selector.mount() };
  }
  const subscribe = (listener: () => void) => holder.current?.mounted.subscribe(listener) ?? (() => undefined);
  const getSnapshot = () => {
    const snapshot = holder.current?.mounted.getSnapshot();
    if (snapshot?.status !== 'available') return fallback;
    const raw = snapshot.value;
    return axis === undefined ? raw : Number((raw as ArrayLike<unknown>)[axis] ?? fallback);
  };
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function useLiveFieldNumber(
  fallback: number,
  field: LiveFieldBinding | undefined,
  axis: number | undefined,
): number {
  const value = useLiveFieldValue(fallback, field, axis);
  return typeof value === 'number' ? value : fallback;
}

function useRemoteInspectorProjection(): InspectorRuntimeProjection | undefined {
  const connection = useSyncExternalStore(
    subscribeViewportRuntimeClient,
    getViewportRuntimeClientSnapshot,
    getViewportRuntimeClientSnapshot,
  );
  const [projection, setProjection] = useState<InspectorRuntimeProjection | undefined>();
  useEffect(() => {
    if (connection.status !== 'ready') {
      setProjection(undefined);
      return;
    }
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const envelope = await queryViewportRuntimeProjection<InspectorRuntimeProjection>({ kind: 'inspector.selection' });
        if (disposed) return;
        setProjection(envelope.status === 'ready'
          ? envelope.value
          : envelope.status === 'empty' ? { selectionIds: [] } : undefined);
      } catch {
        if (!disposed) setProjection(undefined);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 100);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [connection.runtime?.runtimeId, connection.runtime?.runtimeGeneration, connection.status]);
  return projection;
}

function RemoteInspectorPanel({ projection }: { projection: InspectorRuntimeProjection | undefined }) {
  const { t } = useTranslation();
  const entity = projection?.entity;
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameAttempt, setRenameAttempt] = useState(0);
  useEffect(() => setRenameError(null), [entity?.id]);
  if (entity === undefined) {
    return (
      <div className="fx-inspector" data-testid="panel-inspector" data-runtime-projection="1">
        <div className="dp-empty">{t('editor.inspector.noSelection')}</div>
      </div>
    );
  }
  return (
    <div className="fx-inspector" data-testid="panel-inspector" data-runtime-projection="1">
      <div className="dp-name">
        <span className="tico"><ForgeaxIcon name={headerIcon(entity.components as Record<string, unknown>)} size={15} /></span>
        <NameField
          key={`${entity.id}:${renameAttempt}`}
          value={entity.name}
          onCommit={(name) => {
            if (!name || name === entity.name) return;
            void dispatchActiveEditorOperation({ kind: 'rename', entity: entity.id, name })
              .then((result) => {
                if (result.ok) {
                  setRenameError(null);
                  return;
                }
                setRenameError(result.error.hint);
                setRenameAttempt((attempt) => attempt + 1);
              });
          }}
        />
        <span className="idbadge" data-testid="insp-id">#{entity.id}</span>
        <span className="badge">{deriveKind(entity.components as Record<string, unknown>)}</span>
      </div>
      {renameError && <div className="dp-note" role="alert">{renameError}</div>}
      {Object.entries(entity.components)
        .filter(([name]) => name !== 'Name' && !isComponentHidden(name))
        .map(([name, value]) => (
          <div className={`dp-comp ${compDim(name)}`} data-testid={`insp-comp-${name}`} key={name}>
            <div className="ch">
              <span className="ci"><ForgeaxIcon name={compIcon(name)} size={14} /></span>
              <span className="lbl">{componentTypeLabel(name, t)}</span>
            </div>
            <pre className="dp-note" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {JSON.stringify(value, null, 2)}
            </pre>
          </div>
        ))}
    </div>
  );
}

export function InspectorPanel() {
  const remote = useRemoteInspectorProjection();
  if (remote !== undefined) return <RemoteInspectorPanel projection={remote} />;
  return <LocalInspectorPanel />;
}

function LocalInspectorPanel() {
  const { t } = useTranslation();
  const sel = useSelection();
  const selList = useSelectionList();
  // Component values are the authored document snapshot. Asset binding resolves
  // asynchronously through bindAssetRef and may keep the same selection, so the
  // Inspector must re-read the selected entity after the Gateway's document
  // notification; otherwise the input can display the previous asset name while
  // the operation center and Gateway already show the new GUID.
  useDocVersion();
  const fieldPrev = useFieldPreview();
  const readOnly = gateway.mode === 'play';
  const dispatchMutation = (op: EditorOp) => {
    if (readOnly) return;
    gateway.dispatch(projectSceneInstanceMutation(op));
  };
  const runtimeUiGraph = getActiveRuntimeUiGraph();
  const worldGeneration = runtimeUiGraph?.stats().worldGeneration ?? 0;
  const selectionGeneration = `${sel ?? 'none'}:${worldGeneration}:${gateway.mode}`;
  const projectionSource = getOperationProjectionSource();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState('');
  // Open asset-picker target: which field (and array slot) the click-to-browse
  // modal is bound to. null = closed.
  const [picker, setPicker] = useState<{ comp: string; field: string; assetType: string; slot?: number; currentGuid?: string | null } | null>(null);
  // euler React state — scheme B: quat SSOT in world, euler is transient overlay.
  const [rotationDraft, setRotationDraft] = useState<{ rotX: number; rotY: number; rotZ: number }>({ rotX: 0, rotY: 0, rotZ: 0 });
  const cancelDraft = () => {
    if (sel === null) {
      setRotationDraft({ rotX: 0, rotY: 0, rotZ: 0 });
      return;
    }
    const tv = entComponent(gateway.activeWorld, sel, 'Transform', readOptsFor(sel));
    if (!tv.ok) {
      setRotationDraft({ rotX: 0, rotY: 0, rotZ: 0 });
      return;
    }
    const q = readVec(fieldSchema('Transform', 'quat'), (tv.value as Record<string, unknown>).quat);
    setRotationDraft(quatToEuler(q[0]!, q[1]!, q[2]!, q[3]!));
  };
  useEffect(() => {
    cancelDraft();
  }, [sel, worldGeneration]);
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
    dispatchMutation({
      kind: 'bindAssetRef',
      entity: sel,
      component: picker.comp,
      field: picker.field,
      assetType: picker.assetType,
      guids: [guid],
      requestId: crypto.randomUUID(),
      ...(picker.slot !== undefined ? { slot: picker.slot } : {}),
    });
  };
  const clearPicked = (): void => {
    if (!picker || sel === null) return;
    if (picker.slot === undefined) {
      const cur = entComponent(gateway.activeWorld, sel, picker.comp);
      const currentValue = cur.ok ? (cur.value as Record<string, unknown>)[picker.field] : undefined;
      const clearValue = typeof currentValue === 'number' ? 0 : '';
      dispatchMutation({ kind: 'setComponent', entity: sel, component: picker.comp, patch: { [picker.field]: clearValue } });
      return;
    }
    const cur = entComponent(gateway.activeWorld, sel, picker.comp);
    const arr = cur.ok ? Array.from((((cur.value as Record<string, unknown>)[picker.field] ?? []) as ArrayLike<unknown>)) : [];
    arr[picker.slot] = 0;
    dispatchMutation({ kind: 'setComponent', entity: sel, component: picker.comp, patch: { [picker.field]: arr } });
  };
  if (selList.size > 1) {
    return <BatchPanel ids={[...selList]} />;
  }
  if (sel === null || !entExists(gateway.activeWorld, sel)) {
    return (
      <div className="fx-inspector" data-testid="panel-inspector">
        <div data-testid="inspector-product-projection" data-revision={projectionSource.getSnapshot().revision} />
        <div className="dp-empty">{t('editor.inspector.noSelection')}</div>
      </div>
    );
  }
  const nodeName = entName(gateway.activeWorld, sel);
  const nodeComponents = entComponents(gateway.activeWorld, sel, readOptsFor(sel));
  const sceneInstance = gateway.sceneInstanceForMember(sel);
  const sceneInstanceMember = sceneInstance.ok
    ? sceneInstance.value.members.find((member) => member.entity === sel)
    : undefined;
  const missingComponents = listComponentSchemas()
    .map((schema) => schema.name)
    .filter((c) => nodeComponents[c] === undefined);
  // Drop `Name` (rendered via NameField in the header) and any component the
  // editor overlay marks `meta.editor.hidden` (Entity / Children / ChildOf,
  // injected post-registration from editor-component-meta.json). The strip
  // enumerates ALL present components, so this filtering must happen here, not
  // only in the schema registry.
  const bodyComponents = Object.entries(nodeComponents).filter(([comp]) => comp !== 'Name' && !isComponentHidden(comp));
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
      <div data-testid="inspector-product-projection" data-revision={projectionSource.getSnapshot().revision} />
      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="dp-name">
        <span className="tico"><ForgeaxIcon name={headerIcon(nodeComponents)} size={15} /></span>
        <NameField key={sel} value={nodeName} onCommit={(name) => { if (name && name !== nodeName) dispatchMutation({ kind: 'rename', entity: sel, name }); }} />
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

      {sceneInstance.ok && sceneInstanceMember !== undefined && (
        <div className="dp-comp" data-testid="insp-scene-instance">
          <div className="ch">
            <span className="lbl">Scene Instance</span>
            <span className="badge">local {sceneInstanceMember.localId}</span>
          </div>
          <div className="dp-note" data-testid="insp-scene-instance-source">
            source: {sceneInstance.value.source.name ?? sceneInstance.value.source.guid ?? sceneInstance.value.source.kind}
            {' · '}root #{sceneInstance.value.root}
            {' · '}{sceneInstance.value.overrides.filter((override) => override.member === sel).length} override(s)
          </div>
          {sceneInstance.value.overrides
            .filter((override) => override.member === sel && override.field !== undefined)
            .map((override) => (
              <div className="f-row" key={`${override.component}:${override.field}`} data-testid={`insp-scene-instance-override-${override.component}-${override.field}`}>
                <span className="f-name">{override.component}.{override.field}</span>
                <span className="f-val">
                  <button
                    type="button"
                    className="fbtn"
                    data-testid={`insp-instance-revert-${override.component}-${override.field}`}
                    onClick={() => dispatchMutation({ kind: 'removeSceneOverride', root: sceneInstance.value.root, member: sel, component: override.component, field: override.field! })}
                  >
                    revert
                  </button>
                </span>
              </div>
            ))}
        </div>
      )}

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
                if (commands.length) dispatchMutation({ kind: 'transaction', label: `reset all on #${sel}`, commands });
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
                  onSelect={() => dispatchMutation({ kind: 'addComponent', entity: sel, component: c, value: defaultComponentData(c) })}
                >
                  <span className="mi"><ForgeaxIcon name={compIcon(c)} size={14} /></span>{componentTypeLabel(c, t)}
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
            <span className="comp-name">{componentTypeLabel(comp, t)}</span>
            <button
              type="button"
              className="comp-del"
              data-testid={`insp-comprow-remove-${comp}`}
              title="remove component"
              onClick={(e) => { e.stopPropagation(); dispatchMutation({ kind: 'removeComponent', entity: sel, component: comp }); }}
            >
              <ForgeaxIcon name="trash" size={12} />
            </button>
          </div>
        ))}
      </div>

      {/* ── Body: per-component categories ─────────────────────────
          The Hierarchy "Parent" dropdown was removed here: parent linkage is an
          internal relationship (ChildOf) surfaced via drag-reparent in the
          Hierarchy panel, not an editable Inspector field. */}
      <div className="dp-body">
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
                <span className="ct">{componentTypeLabel(comp, t)}</span>
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
                      onClick={(e) => { e.stopPropagation(); dispatchMutation({ kind: 'setComponent', entity: sel, component: comp, patch: defaultComponentData(comp) }); }}
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
                      onClick={(e) => { e.stopPropagation(); dispatchMutation({ kind: 'removeComponent', entity: sel, component: comp }); }}
                    >
                      <ForgeaxIcon name="trash" size={13} />
                    </button>
                  )}
                </span>
              </div>
              {isCollapsed ? null : (() => {
                // Bespoke editors (animation-preview M1): the component's meta
                // contract may name a bespoke editorId. A registered editor renders
                // ABOVE the generic fields (fields stay editable); an unregistered
                // id keeps the historical hint-only fallback.
                const bespoke = getComponentSchema(comp)?.bespoke;
                const BespokeEditor = bespoke !== undefined ? getBespokeEditor(bespoke.editorId) : undefined;
                if (bespoke !== undefined && BespokeEditor === undefined) {
                  return (
                    <div className="bespoke-hint" data-testid={`insp-bespoke-${comp}`}>
                      <span className="bespoke-icon"><ForgeaxIcon name="hexagon" size={13} /></span>
                      <span>{bespoke.hint}</span>
                    </div>
                  );
                }
                return (
                  <>
                    {BespokeEditor !== undefined ? <BespokeEditor entity={sel} component={comp} /> : null}
                    {typeof value === 'object' && value !== null ? (
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
                      if (!isVectorRendererKind(inspectorFieldRendererKind(f))) continue;
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
                                onChange={(e) => dispatchMutation({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: srgbHexToLinear(e.target.value) } })}
                              />
                              <span className="hexval" data-testid={`insp-${comp}-${f.key}-hex`}>{hex}</span>
                              {resetBtn(f.key, data[f.key], () => dispatchMutation({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: defaults[f.key] } }))}
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
                                  liveField={{ entity: sel, component: comp, field: f.key, read: (world) => {
                                    const result = entComponent(world as Parameters<typeof entComponent>[0], sel, comp, readOptsFor(sel));
                                    if (!result.ok) throw new Error(result.error.code);
                                    return result.value[f.key];
                                  } }}
                                  axis={i}
                                  onCommit={(val) => {
                                    const next = readVec(f, data[f.key]);
                                    next[i] = val;
                                    dispatchMutation({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: next } });
                                  }}
                                />
                              </span>
                            ))}
                            {resetBtn(f.key, data[f.key], () => dispatchMutation({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: defaults[f.key] } }))}
                          </span>
                        </div>,
                      );
                    }

                    // Transform euler overlay (scheme B): edit degrees, write quat.
                    if (comp === 'Transform' && fieldMatches(comp, 'rotation')) {
                      const commitEuler = (key: string, deg: number) => {
                        const next = { ...rotationDraft, [key]: deg };
                        setRotationDraft(next);
                        const [qx, qy, qz, qw] = eulerToQuat(next.rotX, next.rotY, next.rotZ);
                        dispatchMutation({ kind: 'setComponent', entity: sel, component: 'Transform', patch: { quat: [qx, qy, qz, qw] } });
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
                                  key={`${selectionGeneration}:${r.key}`}
                                  value={rotationDraft[r.key as keyof typeof rotationDraft]}
                                  fs={{ key: r.key, type: 'number', step: 1, tooltip: r.tooltip }}
                                  testid={r.testid}
                                  className="box-i"
                                  onCommit={(val) => commitEuler(r.key, val)}
                                />
                              </span>
                            ))}
                            {(() => {
                              const rotDirty = Math.abs(rotationDraft.rotX) > 1e-4 || Math.abs(rotationDraft.rotY) > 1e-4 || Math.abs(rotationDraft.rotZ) > 1e-4;
                              return (
                                <button
                                  type="button"
                                  className={`reset${rotDirty ? '' : ' hidden'}`}
                                  data-testid="insp-Transform-rotation-reset"
                                  title="reset rotation to default"
                                  tabIndex={rotDirty ? 0 : -1}
                                  onClick={rotDirty ? () => { setRotationDraft({ rotX: 0, rotY: 0, rotZ: 0 }); dispatchMutation({ kind: 'setComponent', entity: sel, component: 'Transform', patch: { quat: [0, 0, 0, 1] } }); } : undefined}
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
                      if (inspectorFieldRendererKind(f) !== 'asset-ref') continue;
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
                            dispatchMutation({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: resizedTo(slotCount) } });
                          }
                          setPicker({ comp, field: f.key, assetType: arrType, slot: i, currentGuid });
                          return;
                        }
                        // Fixed-capacity arrays (array<shared<T>,N>, e.g.
                        // AnimationPlayer.clips): every slot already exists —
                        // open the picker AT slot i. The variable-array path
                        // below would append an element past the engine's fixed
                        // column capacity.
                        if (f.arrayMeta?.length !== undefined) {
                          setPicker({ comp, field: f.key, assetType: arrType, slot: i, currentGuid });
                          return;
                        }
                        const at = items.length;
                        dispatchMutation({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: [...items, 0] } });
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
                                  onClick={() => dispatchMutation({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: resizedTo(slotCount) } })}
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
                                const assetMissing = handleNum > 0 && desc?.ok !== true;
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
                                        dispatchMutation({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: resizedTo(slotCount) } });
                                      } else if (virtual) {
                                        dispatchMutation({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: [...items, 0] } });
                                      }
                                      dispatchMutation({
                                        kind: 'bindAssetRef',
                                        entity: sel,
                                        component: comp,
                                        field: f.key,
                                        assetType: arrType,
                                        guids: [ref.guid],
                                        requestId: crypto.randomUUID(),
                                        slot: virtual ? items.length : i,
                                      });
                                    }}
                                    onDragOver={(e) => e.preventDefault()}
                                  >
                                    <AssetPreview bound={handleNum > 0 && !assetMissing} kind={slotKind} meta={slotMeta} guid={slotGuid ?? undefined} />
                                    <span className={`an${handleNum > 0 && !assetMissing ? '' : ' empty'}`} title={matName}>
                                      {assetMissing ? 'Missing asset — browse to repair' : handleNum > 0 ? matName : (locked ? `slot ${i} — browse ${arrType}` : `click / drop ${arrType}`)}
                                    </span>
                                    {assetMissing && <span className="asset-missing" role="status" data-testid={`insp-${comp}-${f.key}-slot-${i}-missing`}>missing</span>}
                                    <span className="abtn">
                                      {locked && handleNum > 0 && (
                                        <button type="button" title="clear slot" onClick={(e) => {
                                          e.stopPropagation();
                                          dispatchMutation({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: resizedTo(slotCount).map((h, j) => (j === i ? 0 : h)) } });
                                        }}><ForgeaxIcon name="x" size={12} /></button>
                                      )}
                                      {!locked && !virtual && (
                                        <button type="button" title="remove slot" onClick={(e) => {
                                          e.stopPropagation();
                                          const next = items.filter((_, j) => j !== i);
                                          dispatchMutation({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: next } });
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
                                  <button type="button" className="fbtn" onClick={() => dispatchMutation({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: [...items, 0] } })}>
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
                      const fs = fieldSchema(comp, k);
                      const inferredType = typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : typeof v === 'string' ? 'string' : undefined;
                      const renderer = inspectorFieldRendererKind(fs ?? (inferredType ? { type: inferredType } : undefined));
                      if (isVectorRendererKind(renderer)) continue;
                      if (renderer === 'asset-ref' && (Array.isArray(v) || ArrayBuffer.isView(v))) continue;
                      // Skip derived arrays with no schema entry (e.g. Transform.world,
                      // reflected as transient and excluded from ComponentSchema.fields,
                      // but present in runtime data and resurfaced by mergedFieldKeys).
                      if (!fs && (Array.isArray(v) || ArrayBuffer.isView(v))) continue;
                      if (isUnsupportedRendererKind(renderer)) {
                        out.push(<UnsupportedField component={comp} field={k} kind={fs?.shape ?? renderer} key={k} />);
                        continue;
                      }
                      if (renderer === 'array' && fs !== undefined) {
                        out.push(
                          <div className="f-row" key={`${sel}:${comp}:${k}`} data-testid={`insp-field-${comp}-${k}`} style={{ alignItems: 'flex-start' }}>
                            <span className="f-name" title={fs.tooltip}>{k}</span>
                            <span className="f-val">
                              <ArrayFieldEditor
                                entity={sel}
                                component={comp}
                                field={k}
                                fs={fs}
                                value={v}
                                data={data}
                                readOnly={readOnly}
                                dispatch={dispatchMutation}
                                reset={resetBtn(k, v, () => {
                                  const group = fs.arrayGroup;
                                  const resetFields = (getComponentSchema(comp)?.fields ?? [])
                                    .filter((candidate) => candidate.arrayMeta !== undefined && (group === undefined ? candidate.key === k : candidate.arrayGroup === group));
                                  dispatchMutation({
                                    kind: 'setComponent',
                                    entity: sel,
                                    component: comp,
                                    patch: Object.fromEntries(resetFields.map((candidate) => [candidate.key, defaults[candidate.key] ?? []])),
                                  });
                                })}
                              />
                            </span>
                          </div>,
                        );
                        continue;
                      }
                      if (v !== null && typeof v === 'object') continue;
                      const setField = (val: unknown) => {
                        if (readOnly) return;
                        dispatchMutation({ kind: 'setComponent', entity: sel, component: comp, patch: { [k]: val } });
                      };
                      const reset = resetBtn(k, v, () => setField(defaults[k]));
                      if (renderer === 'optional') {
                        out.push(
                          <div className="f-row" key={`${sel}:${comp}:${k}`} data-testid={`insp-field-${comp}-${k}`}>
                            <span className="f-name" title={fs?.tooltip}>{k}</span>
                            <span className="f-val">
                              <OptionalInput
                                value={v}
                                fs={fs}
                                testid={`insp-${comp}-${k}`}
                                liveField={{ entity: sel, component: comp, field: k, read: (world) => {
                                  const result = entComponent(world as Parameters<typeof entComponent>[0], sel, comp, readOptsFor(sel));
                                  if (!result.ok) throw new Error(result.error.code);
                                  return result.value[k];
                                } }}
                                onCommit={setField}
                              />
                              {reset}
                            </span>
                          </div>,
                        );
                        continue;
                      }
                      if (renderer === 'scalar') {
                        const liveNum = fieldPrev && fieldPrev.id === sel && fieldPrev.key === `${comp}.${k}` ? fieldPrev.value : (typeof v === 'number' ? v : 0);
                        const ranged = fs?.min !== undefined && fs?.max !== undefined;
                        out.push(
                          <div className="f-row" key={`${sel}:${comp}:${k}`} data-testid={`insp-field-${comp}-${k}`}>
                            <span className="f-name" title={fs?.tooltip}>{k}</span>
                            <span className="f-val">
                              {ranged && (
                                <input type="range" min={fs!.min} max={fs!.max} step={fs?.step ?? 0.01} data-testid={`insp-${comp}-${k}-slider`} value={liveNum} onChange={(e) => setField(Number(e.target.value))} />
                              )}
                              <ScrubInput
                                key={`${selectionGeneration}:${comp}:${k}`}
                                value={liveNum}
                                fs={fs}
                                testid={`insp-${comp}-${k}`}
                                className="box-i num"
                                liveField={{ entity: sel, component: comp, field: k, read: (world) => {
                                  const result = entComponent(world as Parameters<typeof entComponent>[0], sel, comp, readOptsFor(sel));
                                  if (!result.ok) throw new Error(result.error.code);
                                  return result.value[k];
                                } }}
                                onCommit={setField}
                              />
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
                      const assetBound = renderer === 'asset-ref' ? (typeof v === 'number' ? v > 0 : strVal !== '') : false;
                      out.push(
                        <div className="f-row" key={k} data-testid={`insp-field-${comp}-${k}`}>
                          <span className="f-name" title={fs?.tooltip}>
                            {k}
                            {renderer === 'asset-ref' && <span className="asset-dot" data-testid={`insp-${comp}-${k}-dot`}>{assetBound ? <ForgeaxIcon name="dot" size={9} /> : <ForgeaxIcon name="hexagon" size={9} />}</span>}
                          </span>
                          <span className="f-val">
                            {renderer === 'boolean' ? (
                              <BoolCheckbox checked={v === true} testid={`insp-${comp}-${k}`} onToggle={(c) => setField(c)} />
                            ) : renderer === 'enum' ? (
                              <EnumSelect
                                value={Number(v)}
                                options={fs?.enumOptions ?? []}
                                testid={`insp-${comp}-${k}`}
                                liveField={{ entity: sel, component: comp, field: k, read: (world) => {
                                  const result = entComponent(world as Parameters<typeof entComponent>[0], sel, comp, readOptsFor(sel));
                                  if (!result.ok) throw new Error(result.error.code);
                                  return result.value[k];
                                } }}
                                onChange={setField}
                              />
                            ) : renderer === 'asset-ref' ? (
                              (() => {
                                const scalarType = expectedAssetType(comp, k) ?? 'MeshAsset';
                                const curDesc = typeof v === 'number' && v > 0 ? gateway.describeAsset(v) : null;
                                const curGuid = curDesc?.ok ? curDesc.guid : undefined;
                                const curKind = curDesc?.ok ? curDesc.kind : undefined;
                                const curMeta = curDesc?.ok ? curDesc.meta : undefined;
                                const assetMissing = assetBound && curDesc?.ok !== true;
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
                                          dispatchMutation({ kind: 'bindAssetRef', entity: sel, component: comp, field: k, assetType: scalarType, guids: [ref.guid], requestId: crypto.randomUUID() });
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
                                    {assetMissing && <span className="asset-missing" role="status" data-testid={`insp-${comp}-${k}-missing`}>Missing asset — browse to repair</span>}
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
                            {renderer !== 'asset-ref' && reset}
                          </span>
                        </div>,
                      );
                    }
                    return out;
                  })()}
                </div>
                    ) : null}
                  </>
                );
              })()}
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
