import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { showContextMenu } from '@forgeax/editor-core';
import { childrenOf } from '@forgeax/editor-core';
import { clampToField, defaultComponentData, eulerToQuat, fieldSchema, fieldVisible, getComponentSchema, listComponentSchemas, quatToEuler, type FieldSchema } from '@forgeax/editor-core';
// M3 (AC-03, plan-strategy §2 D-6): mutations + view-intent ops go through the
// one gateway door — gateway.dispatch({ kind, … }) — replacing the direct setters
// (setSelectionMany / requestFrame) and the origin-less `dispatch` wrapper.
import { gateway, requestRefComponent, useDocVersion, useFieldPreview, useSelection, useSelectionList } from '@forgeax/editor-core';
import { entExists, entName, entParent, entComponent, entComponents, entIds } from '@forgeax/editor-core';
import type { EditorOp, EntityId } from '@forgeax/editor-core';

// DCC-style number field: the label is a horizontal drag handle ("scrub"). While
// dragging we only track a LOCAL preview value and commit a single command on
// release → the whole drag is one undo step. Typing in the box still works.
function NameField({ value, onCommit }: { value: string; onCommit: (name: string) => void }) {
  const [draft, setDraft] = useState(value);
  const abort = useRef(false);
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
  return (
    <div className={compact ? `field vec3-cell vec3-${axis}` : `field${appear ? ' appear-in' : ''}`} data-testid={`${testid}-field`}>
      <label
        className="scrub"
        title={fs?.tooltip ?? 'drag to scrub'}
        data-testid={`${testid}-scrub`}
        onPointerDown={(e) => {
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
        type="number"
        step={fs?.step}
        min={fs?.min}
        max={fs?.max}
        style={{ maxWidth: 72 }}
        data-testid={testid}
        value={display}
        onChange={(e) => onCommit(clampToField(fs, Number(e.target.value)))}
      />
    </div>
  );
}

// Components whose three number fields read as a single vec3 → render inline.
const VEC3_GROUPS: Record<string, [string, string, string]> = {
  Transform: ['posX', 'posY', 'posZ'],
};

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

function descendantsAndSelf(id: EntityId): Set<EntityId> {
  const out = new Set<EntityId>([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of childrenOf(gateway.doc, cur)) {
      out.add(c);
      stack.push(c);
    }
  }
  return out;
}

// Components present on EVERY selected entity (batch edit operates on these).
function commonComponents(ids: EntityId[]): string[] {
  if (ids.length === 0) return [];
  // M7 / AC-15: component keys read from world (SSOT) via entity-state.
  const sets = ids.map((id) => new Set(Object.keys(entComponents(gateway.doc, id))));
  return [...sets[0]!].filter((c) => sets.every((s) => s.has(c)));
}

// Multi-select batch editor: one edit fans out to all selected as a single
// transaction → one undo. The primary entity supplies the field layout.
function BatchPanel({ ids }: { ids: EntityId[] }) {
  const { t } = useTranslation();
  const primary = ids[ids.length - 1]!;
  const common = commonComponents(ids);

  function setAll(component: string, key: string, value: unknown) {
    const commands: EditorOp[] = ids.map((id) => ({ kind: 'setComponent', entity: id, component, patch: { [key]: value } }));
    gateway.dispatch({ kind: 'transaction', label: `batch ${component}.${key} ×${ids.length}`, commands });
  }

  // Align all selected to the primary's value on one axis (one undo step).
  function alignAxis(axis: 'x' | 'y' | 'z') {
    const posKey = `pos${axis.toUpperCase()}` as string;
    const t = entComponent(gateway.doc, primary, 'Transform');
    if (!t) return;
    setAll('Transform', posKey, Number(t[posKey] ?? 0));
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
              return { id, name: entName(gateway.doc, id), components: entComponents(gateway.doc, id) };
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
            {entName(gateway.doc, id) || id}
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
        const value = entComponent(gateway.doc, primary, comp);
        if (typeof value !== 'object' || value === null) return null;
        return (
          <div key={comp}>
            <div className="compname">{comp}</div>
            {(() => {
              const data = value as Record<string, unknown>;
              const grp = VEC3_GROUPS[comp];
              const vec3 = grp && grp.every((g) => typeof data[g] === 'number');
              const rows: ReactNode[] = [];
              if (vec3) {
                rows.push(
                  <div className="vec3-row" data-testid={`batch-${comp}-vec3`} key="__vec3">
                    {grp.map((g) => {
                      const fs = fieldSchema(comp, g);
                      return (
                        <div className={`field vec3-cell vec3-${g.slice(-1)}`} key={g}>
                          <label>{g}</label>
                          <input type="number" step={fs?.step} min={fs?.min} max={fs?.max} data-testid={`batch-${comp}-${g}`} value={Number(data[g])} onChange={(e) => setAll(comp, g, clampToField(fs, Number(e.target.value)))} />
                        </div>
                      );
                    })}
                  </div>,
                );
              }
              return [
                ...rows,
                ...Object.entries(data)
                  .filter(([k]) => !(vec3 && grp.includes(k)) && fieldVisible(comp, fieldSchema(comp, k), data))
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
                    <input type="number" step={fs?.step} min={fs?.min} max={fs?.max} data-testid={`batch-${comp}-${k}`} value={Number(v)} onChange={(e) => setAll(comp, k, clampToField(fs, Number(e.target.value)))} />
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
    // M7 / AC-15: read Transform through entComponent (the dead-world-aware SSOT
    // reader). In a popout window gateway.doc.world is null (snapshot revive keeps it
    // inert), so a raw gateway.doc.world.get(...) NPE'd on selection — entComponent
    // resolves from the popout cache instead. On the main window it reads the live
    // world. Mirrors the childrenOf popout fix.
    const tv = entComponent(gateway.doc, sel, 'Transform');
    if (!tv) return;
    const q = tv as { quatX: number; quatY: number; quatZ: number; quatW: number };
    setEuler(quatToEuler(q.quatX, q.quatY, q.quatZ, q.quatW));
  }, [sel]);
  const toggleComp = (comp: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(comp)) next.delete(comp);
      else next.add(comp);
      return next;
    });
  if (selList.length > 1) {
    return <BatchPanel ids={selList} />;
  }
  if (sel === null || !entExists(gateway.doc, sel)) {
    return (
      <div className="panel" data-testid="panel-inspector">
        <h3>Inspector</h3>
        <div className="field muted">No selection — pick something in the Hierarchy or Viewport.</div>
      </div>
    );
  }
  // M7 / AC-15: entity name/parent/components read from world (SSOT) via
  // entity-state; doc.entities/doc.order/EntityNode.source deleted.
  const nodeName = entName(gateway.doc, sel);
  const nodeParent = entParent(gateway.doc, sel);
  const nodeComponents = entComponents(gateway.doc, sel);
  const blocked = descendantsAndSelf(sel);
  const parentOptions = entIds(gateway.doc).filter((id) => !blocked.has(id));
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
              {entName(gateway.doc, id)} #{id}
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
              <span
                className="x"
                style={{ cursor: 'pointer', color: 'var(--fg3)' }}
                data-testid={`insp-remove-${comp}`}
                onClick={() => gateway.dispatch({ kind: 'removeComponent', entity: sel, component: comp })}
              >
                ×
              </span>
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
                const grp = VEC3_GROUPS[comp];
                const vec3 = grp && grp.every((g) => typeof data[g] === 'number');
                const out: ReactNode[] = [];
                if (vec3) {
                  out.push(
                    <div className="vec3-row" data-testid={`insp-${comp}-vec3`} key="__vec3">
                      {grp.map((g) => (
                        <NumberScrubField key={g} label={g} value={data[g] as number} fs={fieldSchema(comp, g)} testid={`insp-${comp}-${g}`} compact onCommit={(val) => gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [g]: val } })} />
                      ))}
                    </div>,
                  );
                }
                if (comp === 'Transform') {
                  // euler React state (scheme B): read local React state, blur→eulerToQuat→world setComponent
                  // AGENTS.md #6: conversion on editor side, XYZ order, quat SSOT in world
                  const commitEuler = (key: string, deg: number) => {
                    const next = { ...euler, [key]: deg };
                    setEuler(next);
                    const [qx, qy, qz, qw] = eulerToQuat(next.rotX, next.rotY, next.rotZ);
                    gateway.dispatch({ kind: 'setComponent', entity: sel, component: 'Transform', patch: { quatX: qx, quatY: qy, quatZ: qz, quatW: qw } });
                  };
                  const ROTATIONS = [
                    { key: 'rotX', label: 'rotX', tooltip: 'rotation around X (degrees)', testid: 'insp-Transform-rotX' },
                    { key: 'rotY', label: 'rotY', tooltip: 'rotation around Y (degrees)', testid: 'insp-Transform-rotY' },
                    { key: 'rotZ', label: 'rotZ', tooltip: 'rotation around Z (degrees)', testid: 'insp-Transform-rotZ' },
                  ];
                  out.push(
                    <div className="vec3-row" data-testid="insp-Transform-rot-vec3" key="__rot">
                      {ROTATIONS.map((r) => (
                        <NumberScrubField key={r.key} label={r.label} value={euler[r.key as keyof typeof euler]} fs={{ key: r.key, type: 'number', step: 1, tooltip: r.tooltip }} testid={r.testid} compact onCommit={(val) => commitEuler(r.key, val)} />
                      ))}
                    </div>,
                  );
                }
                for (const k of keys) {
                  if (vec3 && grp.includes(k)) continue;
                  const v = data[k];
                  // skip nested object/array data (e.g. Transform.rotation) — surfaced via dedicated widgets, not as "[object Object]"
                  if (v !== null && typeof v === 'object') continue;
                  const fs = fieldSchema(comp, k);
                  const setField = (val: unknown) =>
                    gateway.dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [k]: val } });
                  const type = fs?.type ?? (typeof v === 'number' ? 'number' : 'string');
                  if (type === 'number') {
                    // live-follow any viewport gizmo bound to this `<comp>.<key>` scalar (e.g. Light.spotAngle, Light.range)
                    const liveNum = fieldPrev && fieldPrev.id === sel && fieldPrev.key === `${comp}.${k}` ? fieldPrev.value : (typeof v === 'number' ? v : 0);
                    out.push(<NumberScrubField key={k} label={k} value={liveNum} fs={fs} testid={`insp-${comp}-${k}`} onCommit={setField} appear={!!fs?.showWhen} />);
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
                            onDragEnter={(e) => e.currentTarget.classList.add('drop-hot')}
                            onDragLeave={(e) => e.currentTarget.classList.remove('drop-hot')}
                            onDrop={(e) => {
                              e.preventDefault();
                              e.currentTarget.classList.remove('drop-hot');
                              const uuid = e.dataTransfer.getData('text/plain');
                              if (uuid) setField(uuid);
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
