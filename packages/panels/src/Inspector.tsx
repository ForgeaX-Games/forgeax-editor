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
import { useNumberDraft } from './useNumberDraft';

// DCC-style number field: the label is a horizontal drag handle ("scrub"). While
// dragging we only track a LOCAL preview value and commit a single command on
// release → the whole drag is one undo step. Typing in the box still works.
function NameField({ value, onCommit }: { value: string; onCommit: (name: string) => void }) {
  const [draft, setDraft] = useState(value);
  const abort = useRef(false);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <input
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

function NumberScrubField({ label, value, fs, testid, onCommit, compact, appear }: { label: string; value: number; fs?: FieldSchema | undefined; testid: string; onCommit: (n: number) => void; compact?: boolean | undefined; appear?: boolean | undefined }) {
  const [drag, setDrag] = useState<{ x: number; base: number; v: number } | null>(null);
  const step = fs?.step ?? 0.1;
  const display = drag ? drag.v : value;
  const ranged = !compact && fs?.min !== undefined && fs?.max !== undefined;
  const axis = compact ? label.slice(-1).toLowerCase() : '';
  const numberInput = useNumberDraft(display, fs, onCommit);
  return (
    <div className={compact ? `field vec3-cell vec3-${axis}` : `field${appear ? ' appear-in' : ''}`} data-testid={`${testid}-field`}>
      <label
        className="scrub"
        title={fs?.tooltip ?? 'drag to scrub'}
        data-testid={`${testid}-scrub`}
        onPointerDown={(e) => {
          // A scrub drag steals control from the text field without a natural
          // blur in between — flush any in-progress typed draft first so it
          // isn't silently dropped by the drag that's about to start.
          numberInput.flush();
          (e.target as Element).setPointerCapture(e.pointerId);
          setDrag({ x: e.clientX, base: value, v: value });
        }}
        onPointerMove={(e) =>
          setDrag((d) => (d ? { ...d, v: clampToField(fs, Math.round((d.base + Math.round(e.clientX - d.x) * step) * 1e4) / 1e4) } : d))
        }
        onPointerUp={() => {
          if (drag) onCommit(drag.v);
          setDrag(null);
        }}
      >
        {label}
        {fs?.min !== undefined && fs?.max !== undefined && (
          <span className="range-hint" data-testid={`${testid}-range`}>
            [{fs.min}..{fs.max}]
          </span>
        )}
      </label>
      {ranged && (
        <input type="range" min={fs!.min} max={fs!.max} step={fs?.step ?? 0.01} data-testid={`${testid}-slider`} value={display} onChange={(e) => onCommit(Number(e.target.value))} />
      )}
      <input
        type="text"
        inputMode="decimal"
        style={{ maxWidth: 72 }}
        data-testid={testid}
        value={numberInput.value}
        onFocus={numberInput.onFocus}
        onChange={numberInput.onChange}
        onBlur={numberInput.onBlur}
        onKeyDown={numberInput.onKeyDown}
      />
    </div>
  );
}

// Leaf number input for contexts (like BatchPanel's field list, built inside a
// .map()) that can't call the useNumberDraft hook inline — hooks need a real
// component of their own so call order stays stable across renders.
function NumberDraftInput({ value, fs, testid, onCommit }: { value: number; fs?: FieldSchema | undefined; testid: string; onCommit: (n: number) => void }) {
  const numberInput = useNumberDraft(value, fs, onCommit);
  return (
    <input
      type="text"
      inputMode="decimal"
      data-testid={testid}
      value={numberInput.value}
      onFocus={numberInput.onFocus}
      onChange={numberInput.onChange}
      onBlur={numberInput.onBlur}
      onKeyDown={numberInput.onKeyDown}
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
// Light `color` is stored linear (array<f32,3>, HDR) but a native <input
// type="color"> only speaks 8-bit sRGB. We gamma-encode + clamp to [0,1] for the
// swatch, and decode back to linear on edit. HDR magnitude stays in `intensity`.
function linearToSrgbComponent(c: number): number {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function srgbToLinearComponent(c: number): number {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

// Linear rgb (0..1+, clamped) → "#rrggbb" for a color-input swatch.
function linearToSrgbHex(rgb: number[]): string {
  const hex = [0, 1, 2]
    .map((i) => Math.round(linearToSrgbComponent(Number(rgb[i] ?? 0)) * 255))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
  return `#${hex}`;
}

// "#rrggbb" → linear rgb triple written back to the array<f32,3> column.
function srgbHexToLinear(hex: string): [number, number, number] {
  const group = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())?.[1];
  if (group === undefined) return [0, 0, 0];
  const int = parseInt(group, 16);
  const r = ((int >> 16) & 0xff) / 255;
  const g = ((int >> 8) & 0xff) / 255;
  const b = (int & 0xff) / 255;
  return [srgbToLinearComponent(r), srgbToLinearComponent(g), srgbToLinearComponent(b)];
}

// Addable/resettable components + their default payloads are now derived straight
// from the schema registry (single source of truth shared with the Capabilities
// panel and AI bridge) via defaultComponentData().
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

// Components present on EVERY selected entity (batch edit operates on these).
function commonComponents(ids: EntityHandle[]): string[] {
  if (ids.length === 0) return [];
  // M3 (I1/AC-08): component keys read from the active world (SSOT) via entity-state.
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

  // Align all selected to the primary's value on one position axis (one undo
  // step). pos is an array<f32,3> column, so each aligned entity gets its whole
  // pos array rewritten with the primary's value on `axis` and its own other axes.
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
    <div className="panel" data-testid="panel-inspector">
      <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{t('editor.inspector.batchTitle', { count: ids.length })}</span>
        <button
          type="button"
          className="tbtn"
          data-testid="batch-copy-json"
          title="copy all selected entities as a JSON array (for AI / cross-scene paste)"
          onClick={() => {
            const arr = ids.map((id) => {
              return { id, name: entName(gateway.activeWorld, id), components: entComponents(gateway.activeWorld, id) };
            });
            void navigator.clipboard?.writeText(JSON.stringify(arr, null, 2));
          }}
        >
          ⧉ JSON[]
        </button>
      </h3>
      <div className="field muted" data-testid="batch-note">
        {t('editor.inspector.batchNote')}
      </div>
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
        <div className="field" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <label>{t('editor.inspector.alignToPrimary')}</label>
          {(['x', 'y', 'z'] as const).map((ax) => (
            <button key={ax} type="button" className="tbtn" data-testid={`batch-align-${ax}`} onClick={() => alignAxis(ax)}>
              {ax.toUpperCase()}
            </button>
          ))}
        </div>
      )}
      {common.length === 0 && <div className="field muted">{t('editor.inspector.noCommonComponents')}</div>}
      {common.map((comp) => {
        const valueR = entComponent(gateway.activeWorld, primary, comp);
        if (!valueR.ok || typeof valueR.value !== 'object' || valueR.value === null) return null;
        return (
          <div key={comp}>
            <div className="compname">{comp}</div>
            {(() => {
              const data = valueR.value as Record<string, unknown>;
              const vecFields = (getComponentSchema(comp)?.fields ?? []).filter((f) => f.type === 'vec');
              const vecKeys = new Set(vecFields.map((f) => f.key));
              const rows: ReactNode[] = [];
              // One inline row per vec field. A batch axis edit rewrites each
              // selected entity's WHOLE array, preserving that entity's own other
              // axes (array<f32,N> columns take the full vector, not a scalar).
              for (const f of vecFields) {
                const vec = readVec(f, data[f.key]);
                // Color vec: swatch + hex, batch-writes the WHOLE linear float[3]
                // to every selected entity (mirrors single-selection widget).
                if (f.widget === 'color') {
                  const hex = linearToSrgbHex(vec);
                  rows.push(
                    <div className="field field-color" data-testid={`batch-field-${comp}-${f.key}`} key={`__vec_${f.key}`}>
                      <label title={f.tooltip}>{f.key}</label>
                      <input
                        type="color"
                        data-testid={`batch-${comp}-${f.key}`}
                        value={hex}
                        onChange={(e) => {
                          const rgb = srgbHexToLinear(e.target.value);
                          const commands: EditorOp[] = ids.map((id) => ({ kind: 'setComponent', entity: id, component: comp, patch: { [f.key]: rgb } }));
                          gateway.dispatch({ kind: 'transaction', label: `batch ${comp}.${f.key} ×${ids.length}`, commands });
                        }}
                      />
                      <span className="hexval" data-testid={`batch-${comp}-${f.key}-hex`}>{hex}</span>
                    </div>,
                  );
                  continue;
                }
                const labels = vecAxisLabels(f);
                rows.push(
                  <div className="vec3-row" data-testid={`batch-${comp}-${f.key}`} key={`__vec_${f.key}`}>
                    {vec.map((axVal, i) => (
                      <div className={`field vec3-cell vec3-${labels[i] ?? i}`} key={i}>
                        <label>{labels[i] ?? i}</label>
                        <NumberDraftInput
                          key={`${primary}:${comp}:${f.key}:${i}`}
                          value={axVal}
                          fs={{ key: f.key, type: 'number', step: f.step, tooltip: f.tooltip }}
                          testid={`batch-${comp}-${f.key}-${i}`}
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
                      </div>
                    ))}
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
                      <div className="field" key={k}>
                        <label>{k}</label>
                        {type === 'bool' ? (
                    <input type="checkbox" data-testid={`batch-${comp}-${k}`} checked={v === true} onChange={(e) => setAll(comp, k, e.target.checked)} />
                  ) : type === 'color' ? (
                    <input type="color" data-testid={`batch-${comp}-${k}`} value={String(v) || '#cccccc'} onChange={(e) => setAll(comp, k, e.target.value)} />
                  ) : type === 'enum' ? (
                    <select className="sel" data-testid={`batch-${comp}-${k}`} value={String(v) || fs?.options?.[0] || ''} onChange={(e) => setAll(comp, k, e.target.value)}>
                      {(fs?.options ?? []).map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  ) : type === 'number' ? (
                    <NumberDraftInput key={`${primary}:${comp}:${k}`} value={Number(v)} fs={fs} testid={`batch-${comp}-${k}`} onCommit={(n) => setAll(comp, k, n)} />
                  ) : (
                    <input data-testid={`batch-${comp}-${k}`} value={String(v)} onChange={(e) => setAll(comp, k, e.target.value)} />
                  )}
                      </div>
                    );
                  }),
              ];
            })()}
          </div>
        );
      })}
    </div>
  );
}

// A first cut of the "reflected" inspector: it walks the selected entity's
// components and renders an editable field per scalar. Editing dispatches a
// setComponent command (same path AI would use). Later this becomes
// schema-driven (number→slider w/ min/max, color→swatch, asset→picker).
/** Build the super handle-pair read opts for the primary selection, or undefined
 *  when no active-read binding is registered (headless / play mode) or the primary
 *  selection pair no longer matches `sel` (defensive). When defined, entComponent /
 *  entComponents run the three-layer validateHandlePair check (D-4) so a cross-world
 *  or stale-epoch handle is rejected with a structured error AT THE READ SEAM,
 *  rather than relying solely on the reload collar's revalidateSelection (VERIFY
 *  finding-3 defense-in-depth). Only the primary single-entity Inspector reads are
 *  wired; other read points (BatchPanel, Hierarchy, viewport) remain on the legacy
 *  liveness path as a documented follow-up. */
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
  // euler React state — scheme B (plan-strategy §2 D-2): quat SSOT in world, euler is transient overlay
  const [euler, setEuler] = useState<{ rotX: number; rotY: number; rotZ: number }>({ rotX: 0, rotY: 0, rotZ: 0 });
  // On entity switch: read world quat → euler to reset React state (scheme B)
  useEffect(() => {
    if (sel === null) return;
    // M3 (I1/AC-08): read Transform through entComponent against the active world
    // (edit->editWorld, play->playWorld). A stale handle returns a structured
    // error (ok:false) — treat it as "nothing to show" and bail. VERIFY finding-3:
    // pass the super handle-pair opts so the read runs the three-layer check.
    const tv = entComponent(gateway.activeWorld, sel, 'Transform', readOptsFor(sel));
    if (!tv.ok) return;
    const q = readVec(fieldSchema('Transform', 'quat'), (tv.value as Record<string, unknown>).quat);
    setEuler(quatToEuler(q[0]!, q[1]!, q[2]!, q[3]!));
  }, [sel]);
  const toggleComp = (comp: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(comp)) next.delete(comp);
      else next.add(comp);
      return next;
    });
  if (selList.size > 1) {
    return <BatchPanel ids={[...selList]} />;
  }
  if (sel === null || !entExists(gateway.activeWorld, sel)) {
    return (
      <div className="panel" data-testid="panel-inspector">
        <h3>Inspector</h3>
        <div className="field muted">No selection — pick something in the Hierarchy or Viewport.</div>
      </div>
    );
  }
  // M7 / AC-15: entity name/parent/components read from world (SSOT) via
  // entity-state; doc.entities/doc.order/EntityNode.source deleted.
  const nodeName = entName(gateway.activeWorld, sel);
  const nodeParent = entParent(gateway.activeWorld, sel);
  // VERIFY finding-3: the primary component read runs the three-layer handle-pair
  // check when the active-read binding is registered (edit mode).
  const nodeComponents = entComponents(gateway.activeWorld, sel, readOptsFor(sel));
  const blocked = descendantsAndSelf(sel);
  const parentOptions = worldEntityHandles(gateway.activeWorld).filter((id) => !blocked.has(id));
  const missingComponents = ADDABLE_COMPONENTS.filter((c) => nodeComponents[c] === undefined);
  return (
    <div className="panel" data-testid="panel-inspector">
      <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>
          Inspector <span className="insp-id" data-testid="insp-id">#{sel}</span>
        </span>
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <button
            type="button"
            className="tbtn"
            data-testid="insp-focus"
            title="frame this entity in the viewport (F)"
            onClick={() => gateway.dispatch({ kind: 'requestFrame' })}
          >
            ⌖ Focus
          </button>
          <button
            type="button"
            className="tbtn"
            data-testid="insp-copy-json"
            title="copy this entity as JSON (for AI / cross-scene paste)"
            onClick={() => {
              const json = JSON.stringify({ name: nodeName, components: nodeComponents }, null, 2);
              void navigator.clipboard?.writeText(json);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? '✓ copied' : '⧉ JSON'}
          </button>
        </span>
      </h3>
      {/* M7 / AC-15: EntityNode.source deleted — the edit-source affordance is
          dropped (entity provenance is no longer tracked in the authoring layer). */}
      <div className="field">
        <label>Name</label>
        <NameField key={sel} value={nodeName} onCommit={(name) => { if (name && name !== nodeName) gateway.dispatch({ kind: 'rename', entity: sel, name }); }} />
      </div>
      <div className="field">
        <label>Parent</label>
        <select
          data-testid="insp-parent"
          value={nodeParent ?? ''}
          onChange={(e) => gateway.dispatch({ kind: 'reparent', entity: sel, parent: e.target.value === '' ? null : Number(e.target.value) })}
        >
          <option value="">(root)</option>
          {parentOptions.map((id) => (
            <option key={id} value={id}>
              {entName(gateway.activeWorld, id)} #{id}
            </option>
          ))}
        </select>
      </div>
      {Object.entries(nodeComponents).map(([comp, value]) => (
        <div key={comp}>
          <div
            className="compname"
            style={{ display: 'flex', justifyContent: 'space-between' }}
            onContextMenu={(e) => showContextMenu(e, [
              { label: t('editor.inspector.refToChat'), onClick: () => requestRefComponent(sel, comp, value) },
              { label: t('editor.inspector.copyJson'), onClick: () => { void navigator.clipboard?.writeText(JSON.stringify({ [comp]: value }, null, 2)); } },
            ])}
          >
            <span style={{ cursor: 'pointer' }} data-testid={`insp-comp-toggle-${comp}`} onClick={() => toggleComp(comp)}>
              {collapsed.has(comp) ? '▸' : '▾'} {comp}
            </span>
            <span style={{ display: 'inline-flex', gap: 8 }}>
              <span
                className="x"
                style={{ cursor: 'pointer', color: 'var(--fg3)' }}
                title="copy this component as JSON (for AI / tool-call patch)"
                data-testid={`insp-copy-${comp}`}
                onClick={() => void navigator.clipboard?.writeText(JSON.stringify({ [comp]: value }, null, 2))}
              >
                ⧉
              </span>
              {getComponentSchema(comp) !== undefined && (
                <span
                  className="x"
                  style={{ cursor: 'pointer', color: 'var(--fg3)' }}
                  title="reset to default values"
                  data-testid={`insp-reset-${comp}`}
                  onClick={() => gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: defaultComponentData(comp) })}
                >
                  ↺
                </span>
              )}
              {comp !== 'Name' && (
                <span
                  className="x"
                  style={{ cursor: 'pointer', color: 'var(--fg3)' }}
                  data-testid={`insp-remove-${comp}`}
                  onClick={() => gateway.dispatch({ kind: 'removeComponent', entity: sel, component: comp })}
                >
                  ×
                </span>
              )}
            </span>
          </div>
          {!collapsed.has(comp) && getComponentSchema(comp)?.bespoke ? (
            <div className="bespoke-hint" data-testid={`insp-bespoke-${comp}`}>
              <span className="bespoke-icon">⬡</span>
              <span>{getComponentSchema(comp)!.bespoke!.hint}</span>
            </div>
          ) : !collapsed.has(comp) && typeof value === 'object' && value !== null
            ? (() => {
                const data = value as Record<string, unknown>;
                const keys = mergedFieldKeys(comp, data).filter((k) => fieldVisible(comp, fieldSchema(comp, k), data));
                const out: ReactNode[] = [];
                // Render every schema `vec` field as one inline N-axis row, keyed
                // by array index. Writing an axis dispatches the WHOLE array (the
                // engine array<f32,N> column takes the full vector, not a scalar).
                // For Transform, the `quat` field is NOT rendered raw — the euler
                // overlay below is its editable surface (quat stays the SSOT).
                for (const f of getComponentSchema(comp)?.fields ?? []) {
                  if (f.type !== 'vec') continue;
                  if (comp === 'Transform' && f.key === 'quat') continue;
                  const vec = readVec(f, data[f.key]);
                  // Color vec: render an Unreal-style swatch + hex instead of raw
                  // x/y/z scrubbers. Editing writes the WHOLE linear float[3].
                  if (f.widget === 'color') {
                    const hex = linearToSrgbHex(vec);
                    out.push(
                      <div className={`field field-color${f.showWhen ? ' appear-in' : ''}`} data-testid={`insp-field-${comp}-${f.key}`} key={`__vec_${f.key}`}>
                        <label title={f.tooltip}>{f.key}</label>
                        <input
                          type="color"
                          data-testid={`insp-${comp}-${f.key}`}
                          value={hex}
                          onChange={(e) => gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: srgbHexToLinear(e.target.value) } })}
                        />
                        <span className="hexval" data-testid={`insp-${comp}-${f.key}-hex`}>{hex}</span>
                      </div>,
                    );
                    continue;
                  }
                  const labels = vecAxisLabels(f);
                  out.push(
                    <div className="vec3-row" data-testid={`insp-${comp}-${f.key}`} key={`__vec_${f.key}`}>
                      {vec.map((axVal, i) => (
                        <NumberScrubField
                          key={`${sel}:${comp}:${f.key}:${i}`}
                          label={labels[i] ?? String(i)}
                          value={axVal}
                          fs={{ key: f.key, type: 'number', step: f.step, tooltip: f.tooltip }}
                          testid={`insp-${comp}-${f.key}-${i}`}
                          compact
                          onCommit={(val) => {
                            const next = readVec(f, data[f.key]);
                            next[i] = val;
                            gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: next } });
                          }}
                        />
                      ))}
                    </div>,
                  );
                }
                if (comp === 'Transform') {
                  // euler React state (scheme B): read local React state, blur→eulerToQuat→world setComponent
                  // AGENTS.md #6: conversion on editor side, XYZ order, quat SSOT in world (array<f32,4>)
                  const commitEuler = (key: string, deg: number) => {
                    const next = { ...euler, [key]: deg };
                    setEuler(next);
                    const [qx, qy, qz, qw] = eulerToQuat(next.rotX, next.rotY, next.rotZ);
                    gateway.dispatch({ kind: 'setComponent', entity: sel, component: 'Transform', patch: { quat: [qx, qy, qz, qw] } });
                  };
                  const ROTATIONS = [
                    { key: 'rotX', label: 'rotX', tooltip: 'rotation around X (degrees)', testid: 'insp-Transform-rotX' },
                    { key: 'rotY', label: 'rotY', tooltip: 'rotation around Y (degrees)', testid: 'insp-Transform-rotY' },
                    { key: 'rotZ', label: 'rotZ', tooltip: 'rotation around Z (degrees)', testid: 'insp-Transform-rotZ' },
                  ];
                  out.push(
                    <div className="vec3-row" data-testid="insp-Transform-rot-vec3" key="__rot">
                      {ROTATIONS.map((r) => (
                        <NumberScrubField key={`${sel}:${r.key}`} label={r.label} value={euler[r.key as keyof typeof euler]} fs={{ key: r.key, type: 'number', step: 1, tooltip: r.tooltip }} testid={r.testid} compact onCommit={(val) => commitEuler(r.key, val)} />
                      ))}
                    </div>,
                  );
                }
                // Render array<asset> fields (e.g. MeshRenderer.materials) as
                // drop-target slots with add/remove. Scalar asset fields are handled
                // in the main loop below.
                for (const f of getComponentSchema(comp)?.fields ?? []) {
                  if (f.type !== 'asset') continue;
                  const arrVal = data[f.key];
                  // Engine ECS returns array<shared<T>> as TypedArray (Uint32Array),
                  // not plain Array. Accept both.
                  if (!Array.isArray(arrVal) && !ArrayBuffer.isView(arrVal)) continue;
                  const items = Array.from(arrVal as ArrayLike<unknown>);
                  out.push(
                    <div className="field" key={`__arr_${f.key}`} data-testid={`insp-${comp}-${f.key}-array`}>
                      <label title={f.tooltip}>
                        {f.key}
                        <span className="asset-dot">{items.length > 0 ? '◆' : '◇'}</span>
                      </label>
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {items.length === 0 && <span style={{ color: 'var(--fg3)', fontSize: '11px' }}>empty — click + to add a slot</span>}
                        {items.map((item, i) => {
                          const handleNum = typeof item === 'number' ? item : 0;
                          const desc = handleNum > 0 ? gateway.describeAsset(handleNum) : null;
                          const matName = desc?.ok ? (desc.name ?? `#${handleNum}`) : '';
                          const bc = desc?.ok
                            ? (desc.meta?.paramValues as Record<string, unknown> | undefined)?.baseColor as number[] | undefined
                            : undefined;
                          const swatchColor = bc && bc.length >= 3
                            ? `rgb(${Math.round(bc[0]! * 255)},${Math.round(bc[1]! * 255)},${Math.round(bc[2]! * 255)})`
                            : undefined;
                          return (
                            <div
                              key={i}
                              style={{ display: 'flex', gap: 4, alignItems: 'center' }}
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
                                gateway.dispatch({
                                  kind: 'bindAssetRef',
                                  entity: sel,
                                  component: comp,
                                  field: f.key,
                                  assetType: ref.kind ?? 'MaterialAsset',
                                  guids: [ref.guid],
                                  slot: i,
                                });
                              }}
                              onDragOver={(e) => e.preventDefault()}
                            >
                              {handleNum > 0 ? (
                                <>
                                  <span
                                    style={{
                                      display: 'inline-block',
                                      width: 16, height: 16, minWidth: 16,
                                      borderRadius: 3,
                                      border: '1px solid var(--line)',
                                      background: swatchColor ?? 'var(--bg2)',
                                    }}
                                    title={swatchColor ? `baseColor: ${bc!.map((v: number) => v.toFixed(2)).join(', ')}` : 'no baseColor'}
                                  />
                                  <span style={{ flex: 1, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fg)' }} title={matName}>
                                    {matName}
                                  </span>
                                </>
                              ) : (
                                <span style={{ flex: 1, fontSize: '11px', color: 'var(--fg3)' }}>drop material asset here</span>
                              )}
                              <button type="button" className="asset-clear" title="remove slot" onClick={() => {
                                const next = items.filter((_, j) => j !== i);
                                gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: next } });
                              }}>×</button>
                            </div>
                          );
                        })}
                        <button type="button" className="tbtn" style={{ marginTop: 2, fontSize: '11px' }} onClick={() => {
                          gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [f.key]: [...items, 0] } });
                        }}>+ slot</button>
                      </div>
                    </div>,
                  );
                }
                for (const k of keys) {
                  const v = data[k];
                  // skip vec fields (rendered inline above) and any nested
                  // object/array data — surfaced via dedicated widgets, not "[object Object]"
                  if (fieldSchema(comp, k)?.type === 'vec') continue;
                  if (v !== null && typeof v === 'object') continue;
                  const fs = fieldSchema(comp, k);
                  const setField = (val: unknown) =>
                    gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [k]: val } });
                  const type = fs?.type ?? (typeof v === 'number' ? 'number' : 'string');
                  if (type === 'number') {
                    // live-follow any viewport gizmo bound to this `<comp>.<key>` scalar (e.g. Light.spotAngle, Light.range)
                    const liveNum = fieldPrev && fieldPrev.id === sel && fieldPrev.key === `${comp}.${k}` ? fieldPrev.value : (typeof v === 'number' ? v : 0);
                    out.push(<NumberScrubField key={`${sel}:${comp}:${k}`} label={k} value={liveNum} fs={fs} testid={`insp-${comp}-${k}`} onCommit={setField} appear={!!fs?.showWhen} />);
                    continue;
                  }
                  const strVal = v === undefined || v === null ? '' : String(v);
                  out.push(
                    <div className={`field${fs?.showWhen ? ' appear-in' : ''}`} key={k} data-testid={`insp-field-${comp}-${k}`}>
                      <label title={fs?.tooltip}>
                        {k}
                        {type === 'asset' && <span className="asset-dot" data-testid={`insp-${comp}-${k}-dot`}>{strVal ? '◆' : '◇'}</span>}
                      </label>
                      {type === 'bool' ? (
                        <input type="checkbox" data-testid={`insp-${comp}-${k}`} checked={v === true} onChange={(e) => setField(e.target.checked)} />
                      ) : type === 'color' ? (
                        <>
                          <input type="color" data-testid={`insp-${comp}-${k}`} value={strVal || '#cccccc'} onChange={(e) => setField(e.target.value)} />
                          <span className="hexval" data-testid={`insp-${comp}-${k}-hex`}>{strVal || '#cccccc'}</span>
                        </>
                      ) : type === 'enum' ? (
                        <select className="sel" data-testid={`insp-${comp}-${k}`} value={strVal || fs?.options?.[0] || ''} onChange={(e) => setField(e.target.value)}>
                          {(fs?.options ?? []).map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}
                            </option>
                          ))}
                        </select>
                      ) : type === 'asset' ? (
                        <>
                          <input
                            data-testid={`insp-${comp}-${k}`}
                            placeholder="drop / paste asset uuid"
                            value={strVal}
                            onChange={(e) => setField(e.target.value)}
                            onDragEnter={(e) => { e.preventDefault(); e.currentTarget.classList.add('drop-hot'); }}
                            onDragLeave={(e) => e.currentTarget.classList.remove('drop-hot')}
                            onDrop={(e) => {
                              e.preventDefault();
                              e.currentTarget.classList.remove('drop-hot');
                              const assetJson = e.dataTransfer.getData('application/x-forgeax-asset');
                              if (assetJson) {
                                try {
                                  const ref = JSON.parse(assetJson);
                                  if (ref.guid) {
                                    gateway.dispatch({
                                      kind: 'bindAssetRef',
                                      entity: sel,
                                      component: comp,
                                      field: k,
                                      assetType: ref.kind ?? 'MeshAsset',
                                      guids: [ref.guid],
                                    });
                                    return;
                                  }
                                } catch { /* noop */ }
                              }
                            }}
                            onDragOver={(e) => e.preventDefault()}
                          />
                          {strVal && (
                            <button type="button" className="asset-clear" data-testid={`insp-${comp}-${k}-clear`} title="unbind this asset" onClick={() => setField('')}>
                              ×
                            </button>
                          )}
                        </>
                      ) : (
                        <input
                          data-testid={`insp-${comp}-${k}`}
                          value={strVal}
                          onChange={(e) => setField(e.target.value)}
                        />
                      )}
                    </div>,
                  );
                }
                return out;
              })()
            : null}
        </div>
      ))}
      {missingComponents.length > 0 && (
        <div className="field">
          <label>+ Comp</label>
          <select
            className="sel"
            data-testid="insp-add-comp-select"
            defaultValue={missingComponents[0]}
            onChange={() => {
              /* value read on click */
            }}
            id="insp-add-comp-select"
          >
            {missingComponents.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="tbtn"
            data-testid="insp-add-comp"
            onClick={() => {
              const select = document.getElementById('insp-add-comp-select') as HTMLSelectElement | null;
              const comp = select?.value ?? missingComponents[0];
              if (!comp) return;
              gateway.dispatch({ kind: 'addComponent', entity: sel, component: comp, value: defaultComponentData(comp) });
            }}
          >
            add
          </button>
        </div>
      )}
    </div>
  );
}
