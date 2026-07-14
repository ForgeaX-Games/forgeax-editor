import { useEffect, useState } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { showContextMenu, type MenuItemDef } from '@forgeax/editor-core';
import { childrenOf } from '@forgeax/editor-core';
import { entExists, entName, entParent, entComponent, entComponents, worldEntityHandles } from '@forgeax/editor-core';
import { deleteEntityCascade as deleteEntity, deleteManyCascade, duplicateEntity, groupSelected, reparentEntity as reparent, reparentMany, reparentAt, ungroupEntity } from '@forgeax/editor-core';
// M3 (AC-03, plan-strategy §2 D-6): all state mutations go through the one
// gateway door — `gateway.dispatch({ kind, … })` — instead of the old direct store
// setters (setSelection/setHoverEntity/toggleSelection) or the origin-less
// `dispatch` wrapper. Default origin is 'human' (D-6); the payload is the same
// plain-JSON op the AI would build. "Change the door, not the body."
// M3 (I1/AC-08/AC-09): all reads go through gateway.activeWorld (edit->editWorld,
// play->playWorld) + EntityHandle; node key IS the engine handle.
import { gateway, getSelection, getSelectionList, onRenameRequest, requestRefEntity, useDocVersion, useHoverEntity, useSelection, useSelectionList, useLastSelectionDomain } from '@forgeax/editor-core';
import { ENTITY_PRESETS, buildPresetComponents, getPreset } from '@forgeax/editor-core';
import type { EntityHandle } from '@forgeax/editor-core';

interface Menu {
  id: EntityHandle;
  x: number;
  y: number;
}

// in-app drag source — more reliable than DataTransfer.getData, which is in
// "protected" mode (and empty) outside a real user drag.
let draggingId: EntityHandle | null = null;

// Where within a row the pointer is → the drop intent (P0-6). top/bottom quarter
// = insert as a SIBLING before/after; middle = drop INSIDE (become a child).
type DropPos = 'before' | 'inside' | 'after';
function computeDropPos(clientY: number, el: HTMLElement, flat: boolean): DropPos {
  if (flat) return 'inside'; // filtered flat list has no sibling order to honor
  const rect = el.getBoundingClientRect();
  const y = clientY - rect.top;
  if (y < rect.height * 0.25) return 'before';
  if (y > rect.height * 0.75) return 'after';
  return 'inside';
}

// The nodes a drop should move: the whole selection when the dragged node is
// part of it (multi-drag), else just the dragged node (P0-3).
function draggedIds(): EntityHandle[] {
  if (draggingId === null) return [];
  const sel = getSelectionList();
  return sel.has(draggingId) ? [...sel] : [draggingId];
}

// Apply a drop of the dragged node(s) relative to `target` at position `pos`.
// `pos` resolves the TARGET PARENT: 'inside' → become a child of `target`;
// 'before'/'after' → become a SIBLING of `target` (i.e. under target's parent,
// which is the root level when `target` is a root — P0-5). Nodes are appended
// under that parent (precise sibling index is deferred, see reparentAt / plan
// P0-6). `before` is forwarded so a future engine-ordered insert can honor it.
function applyDrop(target: EntityHandle, pos: DropPos): void {
  const ids = draggedIds();
  if (ids.length === 0) return;
  const parent = pos === 'inside' ? target : entParent(gateway.activeWorld, target);
  if (ids.length > 1) {
    reparentMany(ids, parent);
    return;
  }
  reparentAt(ids[0]!, parent, pos === 'before' ? target : null);
}

// Shift+range selection anchor — the last explicitly clicked node (plain click
// or Ctrl+click). Purely a Hierarchy UI concept; not stored in the selection
// store (different panels could have different anchor semantics).
let anchorId: EntityHandle | null = null;

/** Walk the tree in display order, skipping collapsed subtrees. */
function flatVisibleOrder(collapsed: Set<EntityHandle>): EntityHandle[] {
  const result: EntityHandle[] = [];
  function walk(parentId: EntityHandle | null): void {
    for (const id of childrenOf(gateway.activeWorld, parentId)) {
      result.push(id);
      if (!collapsed.has(id)) walk(id);
    }
  }
  walk(null);
  return result;
}

function handleShiftClick(id: EntityHandle, collapsed: Set<EntityHandle>): void {
  const anchor = anchorId ?? getSelection();
  if (anchor === null) {
    gateway.dispatch({ kind: 'setSelection', id });
    anchorId = id;
    return;
  }
  const order = flatVisibleOrder(collapsed);
  const ai = order.indexOf(anchor);
  const ci = order.indexOf(id);
  if (ai < 0 || ci < 0) {
    gateway.dispatch({ kind: 'setSelection', id });
    anchorId = id;
    return;
  }
  const lo = Math.min(ai, ci);
  const hi = Math.max(ai, ci);
  const range = order.slice(lo, hi + 1);
  gateway.dispatch({ kind: 'setSelectionMany', ids: range });
}

const COLLAPSE_KEY = 'forgeax:editor:hier-collapsed';
function loadCollapsed(): Set<EntityHandle> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (raw) return new Set(JSON.parse(raw) as EntityHandle[]);
  } catch {
    /* ignore corrupt persisted state */
  }
  return new Set();
}
function saveCollapsed(set: Set<EntityHandle>): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
  } catch {
    /* storage may be unavailable */
  }
}

function highlightName(name: string, q: string) {
  if (!q) return name;
  const i = name.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return name;
  return (
    <>
      {name.slice(0, i)}
      <mark className="hl">{name.slice(i, i + q.length)}</mark>
      {name.slice(i + q.length)}
    </>
  );
}

function Row({
  id,
  depth,
  onMenu,
  flat,
  collapsed,
  toggleCollapse,
  highlight,
  readOnly,
}: {
  id: EntityHandle;
  depth: number;
  onMenu: (m: Menu) => void;
  flat?: boolean | undefined;
  collapsed?: Set<EntityHandle> | undefined;
  toggleCollapse?: ((id: EntityHandle) => void) | undefined;
  highlight?: string | undefined;
  readOnly?: boolean | undefined;
}) {
  const selList = useSelectionList();
  const hoverId = useHoverEntity();
  const [dropPos, setDropPos] = useState<DropPos | null>(null);
  const [editing, setEditing] = useState(false);
  // F2 (or any panel) can request this row to enter inline-rename mode.
  useEffect(() => onRenameRequest((rid) => rid === id && setEditing(true)), [id]);
  // M3 (I1/AC-08): entity view read from the active world (SSOT) via entity-state
  // helpers keyed by EntityHandle. `hidden` derives from the EditorHidden
  // component; `components` from the world component walk.
  // Cross-game gap: activeWorld may be briefly undefined while old Row fibers still
  // re-render — bail before any world.get (AC-01).
  const world = gateway.activeWorld;
  if (world == null || !entExists(world, id)) return null;
  const nodeName = entName(world, id);
  const nodeComponents = entComponents(world, id);
  const nodeHidden = 'EditorHidden' in nodeComponents;
  const kids = flat ? [] : childrenOf(world, id);
  const isCollapsed = collapsed?.has(id) ?? false;
  function commitRename(next: string) {
    setEditing(false);
    const name = next.trim();
    if (name && name !== nodeName) gateway.dispatch({ kind: 'rename', entity: id, name });
  }
  return (
    <>
      <div
        className={`tn${selList.has(id) ? ' sel' : ''}${dropPos === 'inside' ? ' drop' : ''}${dropPos === 'before' ? ' drop-before' : ''}${dropPos === 'after' ? ' drop-after' : ''}${hoverId === id ? ' hov' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        data-testid={`hier-row-${id}`}
        title={`${nodeName} · #${id}`}
        onMouseEnter={() => gateway.dispatch({ kind: 'setHoverEntity', id })}
        onMouseLeave={() => gateway.dispatch({ kind: 'setHoverEntity', id: null })}
        onClick={(e) => {
          if (e.shiftKey && collapsed) {
            handleShiftClick(id, collapsed);
          } else if (e.metaKey || e.ctrlKey) {
            gateway.dispatch({ kind: 'toggleSelection', id });
            anchorId = id;
          } else {
            gateway.dispatch({ kind: 'setSelection', id });
            anchorId = id;
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          // keep an existing multi-selection if right-clicking inside it
          if (!getSelectionList().has(id)) gateway.dispatch({ kind: 'setSelection', id });
          onMenu({ id, x: e.clientX, y: e.clientY });
        }}
        draggable={!readOnly}
        onDragStart={(e) => {
          if (readOnly) { e.preventDefault(); return; }
          draggingId = id;
          e.dataTransfer.setData('application/x-entity', String(id));
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (draggingId === null || readOnly) return;
          // Don't allow dropping a node onto itself (into/around itself).
          const dragging = draggedIds();
          if (dragging.includes(id) && dragging.length === 1) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const pos = computeDropPos(e.clientY, e.currentTarget, !!flat);
          if (pos !== dropPos) setDropPos(pos);
        }}
        onDragLeave={() => setDropPos(null)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const pos = computeDropPos(e.clientY, e.currentTarget, !!flat);
          setDropPos(null);
          if (draggingId !== null && !readOnly) applyDrop(id, pos);
          draggingId = null;
        }}
        onDragEnd={() => {
          // Fallback cleanup when the drop lands outside any drop zone (P0-2):
          // without this, draggingId lingers and later hovers show a stale line.
          draggingId = null;
          setDropPos(null);
        }}
      >
        <span
          className="dot"
          data-testid={`hier-toggle-${id}`}
          onClick={(e) => {
            if (!kids.length) return;
            e.stopPropagation();
            toggleCollapse?.(id);
          }}
          style={kids.length ? { cursor: 'pointer' } : undefined}
        >
          {kids.length ? (isCollapsed ? '▸' : '▾') : '•'}
        </span>
        {editing ? (
          <input
            className="rename-input"
            data-testid={`hier-rename-${id}`}
            autoFocus
            defaultValue={nodeName}
            onFocus={(e) => e.target.select()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename((e.target as HTMLInputElement).value);
              else if (e.key === 'Escape') setEditing(false);
            }}
            onBlur={(e) => commitRename(e.target.value)}
          />
        ) : (
          <span
            style={nodeHidden ? { opacity: 0.45 } : undefined}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (!readOnly) setEditing(true);
            }}
          >
            {highlight ? highlightName(nodeName, highlight) : nodeName}
          </span>
        )}
        <span className="comp-badges" data-testid={`hier-badges-${id}`}>
          {Object.keys(nodeComponents).map((c) => (
            <span key={c} className="comp-badge" title={c}>
              {c[0]}
            </span>
          ))}
        </span>
        {kids.length > 0 && (
          <span
            className="child-count"
            data-testid={`hier-count-${id}`}
            title={`${kids.length} child node(s)`}
          >
            {kids.length}
          </span>
        )}
        <span
          className="vis"
          data-testid={`hier-vis-${id}`}
          title={nodeHidden ? 'show in viewport' : 'hide in viewport'}
          onClick={(e) => {
            e.stopPropagation();
            if (readOnly) return;
            const newHidden = !nodeHidden;
            gateway.dispatch({ kind: 'setHidden', entity: id, hidden: newHidden });
            if (selList.has(id)) {
              for (const sid of selList) {
                if (sid === id) continue;
                const sameState = entComponent(gateway.activeWorld, sid, 'EditorHidden').ok === nodeHidden;
                if (sameState) gateway.dispatch({ kind: 'setHidden', entity: sid, hidden: newHidden });
              }
            }
          }}
        >
          {nodeHidden ? '⊘' : '◉'}
        </span>
      </div>
      {!isCollapsed &&
        kids.map((k) => (
          <Row key={k} id={k} depth={depth + 1} onMenu={onMenu} collapsed={collapsed} toggleCollapse={toggleCollapse} readOnly={readOnly} />
        ))}
    </>
  );
}

// T5-1 / C4-4: a small scope indicator that lights when the panel's selection
// domain is the current Delete-jurisdiction domain. Pure visual clue — the
// routing decision itself lives in the keyboard router (interface submodule).
function DeleteScopeRing({ active, domain }: { active: boolean; domain: 'entity' | 'asset' }) {
  const other = domain === 'entity' ? 'Content Browser 资产' : 'Hierarchy 实体';
  const here = domain === 'entity' ? 'Hierarchy 实体' : 'Content Browser 资产';
  return (
    <span
      data-testid="delete-scope-ring"
      data-domain={domain}
      data-active={active}
      title={active ? `Delete 键当前管辖：${here}` : `Delete 键当前管辖：${other}`}
      style={{
        display: 'inline-block',
        width: 9,
        height: 9,
        borderRadius: '50%',
        border: `2px solid ${active ? '#4ade80' : '#555'}`,
        background: active ? '#4ade80' : 'transparent',
        boxShadow: active ? '0 0 6px 1px #4ade80' : 'none',
        transition: 'all .15s ease',
      }}
    />
  );
}

// An always-present drop target at the top of the tree for "move to root"
// (P0-5). Dragging a node onto it makes the node a sibling of the top-level
// nodes — the reliable path when the tree is full and there is no reachable
// empty area to drop into. Highlights only while a drag is in progress.
function RootDropBar({ readOnly }: { readOnly: boolean }) {
  const [over, setOver] = useState(false);
  if (readOnly) return null;
  return (
    <div
      className={`hier-root-bar${over ? ' over' : ''}`}
      data-testid="hier-root-bar"
      title="拖到这里：移动到根层"
      onDragOver={(e) => {
        if (draggingId === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const ids = draggedIds();
        if (ids.length > 1) reparentMany(ids, null);
        else if (ids[0] !== undefined) reparent(ids[0], null);
        draggingId = null;
      }}
    >
      — Root —
    </div>
  );
}

export function HierarchyPanel() {
  const { t } = useTranslation();
  useDocVersion();
  const sel = useSelection();
  const selList = useSelectionList();
  // T5-1 / C4-4: show the current Delete-jurisdiction domain as a visual
  // clue (no implicit rule). Lights when this panel's domain (entity) is active.
  const delDomain = useLastSelectionDomain();
  // Play mode makes the active world a read-only simulation view: document ops
  // are rejected at the gateway (`edit-rejected-in-play`). Disable the editing
  // controls so they don't silently no-op (P0-4). enterPlay/exitPlay emit, so
  // useDocVersion re-renders this on mode change.
  const readOnly = gateway.mode === 'play';
  const activeWorld = gateway.activeWorld;
  const worldReady = activeWorld != null;
  const roots = worldReady ? childrenOf(activeWorld, null) : [];
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<EntityHandle>>(loadCollapsed);
  const toggleCollapse = (id: EntityHandle) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveCollapsed(next);
      return next;
    });
  // Build the right-click menu items and hand them to the shared service, which
  // renders at the top layer of the whole window (or posts to the interface
  // parent when embedded in an iframe) — never clipped by this panel's bounds.
  const openMenu = (m: Menu) => {
    if (!worldReady) return;
    // M7 / AC-15: entity name/components read from world (SSOT); doc.entities +
    // EntityNode.source deleted, so the edit-source menu item is dropped.
    const snapshot = [...getSelectionList()];
    const multi = snapshot.length > 1;
    const items: MenuItemDef[] = [];
    if (multi) {
      items.push({ label: t('editor.hierarchy.menu.group', { n: snapshot.length }), onClick: () => groupSelected(snapshot) });
      items.push({ label: t('editor.hierarchy.menu.deleteSelected', { n: snapshot.length }), onClick: () => deleteManyCascade(snapshot) });
      items.push({ sep: true });
    }
    items.push({ label: t('editor.hierarchy.menu.duplicate'), onClick: () => duplicateEntity(m.id) });
    items.push({ label: t('editor.hierarchy.menu.copyJson'), onClick: () => { if (entExists(gateway.activeWorld, m.id)) void navigator.clipboard?.writeText(JSON.stringify({ id: m.id, name: entName(gateway.activeWorld, m.id), components: entComponents(gateway.activeWorld, m.id) }, null, 2)); } });
    items.push({ label: t('editor.hierarchy.menu.refToChat'), onClick: () => requestRefEntity(m.id) });
    if (childrenOf(gateway.activeWorld, m.id).length > 0) items.push({ label: t('editor.hierarchy.menu.ungroup'), onClick: () => ungroupEntity(m.id) });
    items.push({ label: t('editor.hierarchy.menu.delete'), danger: true, onClick: () => { multi ? deleteManyCascade(snapshot) : deleteEntity(m.id); } });
    showContextMenu({ clientX: m.x, clientY: m.y, preventDefault: () => {} }, items);
  };
  const q = query.trim().toLowerCase();
  // When filtering, flatten to all entities whose NAME or any COMPONENT name
  // matches (tree semantics dropped so deep matches surface immediately). Matching
  // by component lets a human/AI find entities by capability, e.g. "light".
  // M7 / AC-15: entity list + name/components come from world (SSOT) via
  // entity-state; doc.order/doc.entities deleted.
  const matches = q && worldReady
    ? worldEntityHandles(activeWorld).filter((id) => {
        return entName(activeWorld, id).toLowerCase().includes(q) || Object.keys(entComponents(activeWorld, id)).some((c) => c.toLowerCase().includes(q));
      })
    : [];

  // Cross-game switch gap: show a quiet placeholder until createApp reinjects doc.world.
  if (!worldReady) {
    return (
      <div className="panel" data-testid="panel-hierarchy" data-world-gap="1" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <h3 style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          Hierarchy
          <DeleteScopeRing active={delDomain === 'entity'} domain="entity" />
        </h3>
        <div className="muted" data-testid="hier-world-gap" style={{ padding: '12px 10px' }}>
          Switching game…
        </div>
      </div>
    );
  }

  return (
    <div
      className="panel"
      data-testid="panel-hierarchy"
      style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      // Step 1 (keyboard-router convergence): wire Delete / Backspace on the panel
      // itself so the keystroke deletes the current entity selection through the
      // one gateway door. JSX onKeyDown is scoped to this panel (G-1 level 2),
      // so it stays even after Step 2 moves the global router in — it never races
      // with the document-level listener. Typing targets (rename input / filter)
      // are excluded so Backspace edits text instead of deleting nodes.
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key !== 'Delete' && e.key !== 'Backspace') return;
        const tgt = e.target as HTMLElement;
        if (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable) return;
        const cur = [...getSelectionList()];
        if (cur.length === 0) return;
        e.preventDefault();
        if (cur.length > 1) deleteManyCascade(cur);
        else deleteEntity(cur[0]!);
      }}
    >
      <h3 style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
        Hierarchy
        <DeleteScopeRing active={delDomain === 'entity'} domain="entity" />
      </h3>
      <div style={{ padding: '6px 10px', display: 'flex', gap: 6, flexWrap: 'wrap', flexShrink: 0 }}>
        <button
          type="button"
          className="tbtn"
          data-testid="btn-add-entity"
          disabled={readOnly}
          onClick={() => gateway.dispatch({ kind: 'spawnEntity', name: 'Entity', parent: sel, components: { Transform: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } } })}
        >
          + Entity
        </button>
        <select
          className="sel"
          data-testid="add-preset-select"
          value=""
          disabled={readOnly}
          title="create a typed entity from a schema-default preset (Light / Camera / …)"
          onChange={(e) => {
            const preset = getPreset(e.target.value);
            if (preset) gateway.dispatch({ kind: 'spawnEntity', name: preset.label, parent: sel, components: buildPresetComponents(preset) });
            e.currentTarget.value = '';
          }}
        >
          <option value="">+ preset…</option>
          {ENTITY_PRESETS.map((p) => (
            <option key={p.label} value={p.label} data-testid={`add-preset-opt-${p.label}`}>
              {p.label}
            </option>
          ))}
        </select>
        <button type="button" className="tbtn" data-testid="btn-duplicate" disabled={readOnly || sel === null} onClick={() => sel !== null && duplicateEntity(sel)}>
          Duplicate
        </button>
        <button type="button" className="tbtn" data-testid="btn-group" disabled={readOnly || selList.size < 2} onClick={() => groupSelected([...getSelectionList()])} title="Group selected under a new parent (Ctrl+G)">
          Group
        </button>
        <button
          type="button"
          className="tbtn"
          data-testid="btn-collapse-all"
          title="collapse / expand all parent nodes"
          onClick={() => {
            const parents = worldEntityHandles(gateway.activeWorld).filter((id) => childrenOf(gateway.activeWorld, id).length > 0);
            const allCollapsed = parents.length > 0 && parents.every((id) => collapsed.has(id));
            const next = allCollapsed ? new Set<EntityHandle>() : new Set(parents);
            setCollapsed(next);
            saveCollapsed(next);
          }}
        >
          ⊟/⊞
        </button>
        <button
          type="button"
          className="tbtn"
          data-testid="btn-delete"
          disabled={readOnly || sel === null}
          onClick={() => {
            const cur = [...getSelectionList()];
            if (cur.length > 1) deleteManyCascade(cur);
            else if (sel !== null) deleteEntity(sel);
          }}
        >
          Delete
        </button>
      </div>
      <div style={{ padding: '0 10px 6px', flexShrink: 0 }}>
        <input
          className="hier-filter"
          data-testid="hier-filter"
          placeholder="filter by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {q ? (
        <div className="tree" data-testid="hier-filtered" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {matches.length === 0 ? (
            <div className="muted" style={{ padding: '4px 10px' }} data-testid="hier-no-match">
              no match
            </div>
          ) : (
            matches.map((id) => <Row key={id} id={id} depth={0} onMenu={openMenu} flat highlight={query.trim()} readOnly={readOnly} />)
          )}
        </div>
      ) : (
        <div
          className="tree"
          data-testid="hier-root-dropzone"
          style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
          onDragOver={(e) => {
            if (draggingId !== null && !readOnly) e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            // Empty area below the rows = move to root (parent = null).
            if (draggingId !== null && !readOnly) {
              const ids = draggedIds();
              if (ids.length > 1) reparentMany(ids, null);
              else if (ids[0] !== undefined) reparent(ids[0], null);
            }
            draggingId = null;
          }}
        >
          <RootDropBar readOnly={readOnly} />
          {roots.map((id) => (
            <Row key={id} id={id} depth={0} onMenu={openMenu} collapsed={collapsed} toggleCollapse={toggleCollapse} readOnly={readOnly} />
          ))}
        </div>
      )}
    </div>
  );
}
