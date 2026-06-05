import { useRef, useState, type ReactNode } from 'react';
import { childrenOf } from '../core/document';
import { clampToField, defaultComponentData, fieldSchema, fieldVisible, getComponentSchema, listComponentSchemas, type FieldSchema } from '../core/schema';
import { focusPanel, openSourcePanel } from '../dock';
import { bus, dispatch, requestFrame, setSelectionMany, useDocVersion, useFieldPreview, useSelection, useSelectionList } from '../store';
import type { EditorCommand, EntityId } from '../core/types';

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
  Transform: ['x', 'y', 'z'],
  Velocity: ['vx', 'vy', 'vz'],
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
    for (const c of childrenOf(bus.doc, cur)) {
      out.add(c);
      stack.push(c);
    }
  }
  return out;
}

// Components present on EVERY selected entity (batch edit operates on these).
function commonComponents(ids: EntityId[]): string[] {
  if (ids.length === 0) return [];
  const sets = ids.map((id) => new Set(Object.keys(bus.doc.entities[id]?.components ?? {})));
  return [...sets[0]!].filter((c) => sets.every((s) => s.has(c)));
}

// Multi-select batch editor: one edit fans out to all selected as a single
// transaction → one undo. The primary entity supplies the field layout.
function BatchPanel({ ids }: { ids: EntityId[] }) {
  const primary = ids[ids.length - 1]!;
  const common = commonComponents(ids);

  function setAll(component: string, key: string, value: unknown) {
    const commands: EditorCommand[] = ids.map((id) => ({ kind: 'setComponent', entity: id, component, patch: { [key]: value } }));
    dispatch({ kind: 'transaction', label: `batch ${component}.${key} ×${ids.length}`, commands });
  }

  // Align all selected to the primary's value on one axis (one undo step).
  function alignAxis(axis: 'x' | 'y' | 'z') {
    const t = bus.doc.entities[primary]?.components.Transform as Record<string, unknown> | undefined;
    if (!t) return;
    setAll('Transform', axis, Number(t[axis] ?? 0));
  }

  const hasTransform = common.includes('Transform');

  return (
    <div className="panel" data-testid="panel-inspector">
      <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Inspector · 批量 ({ids.length})</span>
        <button
          type="button"
          className="tbtn"
          data-testid="batch-copy-json"
          title="copy all selected entities as a JSON array (for AI / cross-scene paste)"
          onClick={() => {
            const arr = ids.map((id) => {
              const n = bus.doc.entities[id];
              return { id, name: n?.name, components: n?.components };
            });
            void navigator.clipboard?.writeText(JSON.stringify(arr, null, 2));
          }}
        >
          ⧉ JSON[]
        </button>
      </h3>
      <div className="field muted" data-testid="batch-note">
        编辑下列共有属性将一次性应用到全部选中（单步撤销）。
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
              setSelectionMany([...ids.filter((x) => x !== id), id]);
            }}
          >
            {bus.doc.entities[id]?.name ?? id}
            {id === primary ? ' ★' : ''}
          </button>
        ))}
      </div>
      {hasTransform && (
        <div className="field" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <label>对齐到 primary</label>
          {(['x', 'y', 'z'] as const).map((ax) => (
            <button key={ax} type="button" className="tbtn" data-testid={`batch-align-${ax}`} onClick={() => alignAxis(ax)}>
              {ax.toUpperCase()}
            </button>
          ))}
        </div>
      )}
      {common.length === 0 && <div className="field muted">选中项无共有组件。</div>}
      {common.map((comp) => {
        const value = bus.doc.entities[primary]?.components[comp];
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
  useDocVersion();
  const sel = useSelection();
  const selList = useSelectionList();
  const fieldPrev = useFieldPreview();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
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
  if (sel === null || !bus.doc.entities[sel]) {
    return (
      <div className="panel" data-testid="panel-inspector">
        <h3>Inspector</h3>
        <div className="field muted">No selection — pick something in the Hierarchy or Viewport.</div>
      </div>
    );
  }
  const node = bus.doc.entities[sel];
  const blocked = descendantsAndSelf(sel);
  const parentOptions = bus.doc.order.filter((id) => !blocked.has(id));
  const missingComponents = ADDABLE_COMPONENTS.filter((c) => node.components[c] === undefined);
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
            onClick={() => requestFrame()}
          >
            ⌖ Focus
          </button>
          <button
            type="button"
            className="tbtn"
            data-testid="insp-copy-json"
            title="copy this entity as JSON (for AI / cross-scene paste)"
            onClick={() => {
              const json = JSON.stringify({ name: node.name, components: node.components }, null, 2);
              void navigator.clipboard?.writeText(json);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? '✓ copied' : '⧉ JSON'}
          </button>
        </span>
      </h3>
      {node.source && (
        <div className="insp-source" data-testid="insp-source">
          <span className="src-badge" title="this instance was baked from a Workbench source">
            ⤴ {node.source.plugin}
          </span>
          <button
            type="button"
            className="tbtn"
            data-testid="insp-edit-source"
            onClick={() => node.source && openSourcePanel(node.source.plugin, node.source.docId)}
          >
            编辑源
          </button>
        </div>
      )}
      <div className="field">
        <label>Name</label>
        <NameField key={sel} value={node.name} onCommit={(name) => { if (name && name !== node.name) dispatch({ kind: 'rename', entity: sel, name }); }} />
      </div>
      <div className="field">
        <label>Parent</label>
        <select
          data-testid="insp-parent"
          value={node.parent ?? ''}
          onChange={(e) => dispatch({ kind: 'reparent', entity: sel, parent: e.target.value === '' ? null : Number(e.target.value) })}
        >
          <option value="">(root)</option>
          {parentOptions.map((id) => (
            <option key={id} value={id}>
              {bus.doc.entities[id]?.name} #{id}
            </option>
          ))}
        </select>
      </div>
      {Object.entries(node.components).map(([comp, value]) => (
        <div key={comp}>
          <div className="compname" style={{ display: 'flex', justifyContent: 'space-between' }}>
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
                  onClick={() => dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: defaultComponentData(comp) })}
                >
                  ↺
                </span>
              )}
              <span
                className="x"
                style={{ cursor: 'pointer', color: 'var(--fg3)' }}
                data-testid={`insp-remove-${comp}`}
                onClick={() => dispatch({ kind: 'removeComponent', entity: sel, component: comp })}
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
                        <NumberScrubField key={g} label={g} value={data[g] as number} fs={fieldSchema(comp, g)} testid={`insp-${comp}-${g}`} compact onCommit={(val) => dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [g]: val } })} />
                      ))}
                    </div>,
                  );
                }
                if (comp === 'Transform') {
                  const authoredYaw = ((data.rotation as { y?: unknown } | undefined)?.y as number) || 0;
                  // live-follow the viewport rotation gizmo while it is being dragged
                  const rotY = fieldPrev && fieldPrev.id === sel && fieldPrev.key === 'Transform.rot.y' ? fieldPrev.value : authoredYaw;
                  out.push(
                    <NumberScrubField
                      key="__roty"
                      label="rot.y"
                      value={rotY}
                      fs={{ key: 'rot.y', type: 'number', step: 1, tooltip: 'yaw (degrees, around +Y) — drives the heading ray' }}
                      testid="insp-Transform-roty"
                      onCommit={(val) => dispatch({ kind: 'setComponent', entity: sel, component: 'Transform', patch: { rotation: { y: val } } })}
                    />,
                  );
                }
                for (const k of keys) {
                  if (vec3 && grp.includes(k)) continue;
                  const v = data[k];
                  // skip nested object/array data (e.g. Transform.rotation) — surfaced via dedicated widgets, not as "[object Object]"
                  if (v !== null && typeof v === 'object') continue;
                  const fs = fieldSchema(comp, k);
                  const setField = (val: unknown) =>
                    dispatch({ kind: 'setComponent', entity: sel, component: comp, patch: { [k]: val } });
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
                if (comp === 'Track') {
                  const legacy = typeof data.channel === 'string' && Array.isArray(data.keys) && (data.keys as unknown[]).length > 0 ? 1 : 0;
                  const extra = Array.isArray(data.tracks) ? (data.tracks as unknown[]).length : 0;
                  out.push(
                    <div className="field muted" key="__tracksummary" data-testid="insp-track-summary" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>channels: {legacy + extra}（keys/tracks 在 Timeline 编辑）</span>
                      <button type="button" className="tbtn" data-testid="insp-open-timeline" title="open the Timeline panel to edit keyframes" onClick={() => focusPanel('timeline')}>
                        ⤳ Timeline
                      </button>
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
              dispatch({ kind: 'addComponent', entity: sel, component: comp, value: defaultComponentData(comp) });
            }}
          >
            add
          </button>
        </div>
      )}
    </div>
  );
}
