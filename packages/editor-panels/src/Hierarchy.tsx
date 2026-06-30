import { useEffect, useState } from 'react';
import { useTranslation } from '@forgeax/editor-shared/i18n';
import { showContextMenu, type MenuItemDef } from '@forgeax/editor-shared';
import { childrenOf } from '@forgeax/editor-core';
import { openSourcePanel } from '@forgeax/editor-shared';
import { deleteEntityCascade as deleteEntity, deleteManyCascade, duplicateEntity, groupSelected, reparentEntity as reparent, ungroupEntity } from '@forgeax/editor-shared';
import { bus, dispatch, getSelectionList, onRenameRequest, requestRefEntity, setHoverEntity, setSelection, toggleSelection, useDocVersion, useHoverEntity, useSelection, useSelectionList } from '@forgeax/editor-shared';
import { ENTITY_PRESETS, buildPresetComponents, getPreset } from '@forgeax/editor-core';
import type { EntityId } from '@forgeax/editor-core';

interface Menu {
  id: EntityId;
  x: number;
  y: number;
}

// in-app drag source — more reliable than DataTransfer.getData, which is in
// "protected" mode (and empty) outside a real user drag.
let draggingId: EntityId | null = null;

const COLLAPSE_KEY = 'forgeax:editor:hier-collapsed';
function loadCollapsed(): Set<EntityId> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (raw) return new Set(JSON.parse(raw) as EntityId[]);
  } catch {
    /* ignore corrupt persisted state */
  }
  return new Set();
}
function saveCollapsed(set: Set<EntityId>): void {
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
}: {
  id: EntityId;
  depth: number;
  onMenu: (m: Menu) => void;
  flat?: boolean | undefined;
  collapsed?: Set<EntityId> | undefined;
  toggleCollapse?: ((id: EntityId) => void) | undefined;
  highlight?: string | undefined;
}) {
  const selList = useSelectionList();
  const hoverId = useHoverEntity();
  const [over, setOver] = useState(false);
  const [editing, setEditing] = useState(false);
  // F2 (or any panel) can request this row to enter inline-rename mode.
  useEffect(() => onRenameRequest((rid) => rid === id && setEditing(true)), [id]);
  const node = bus.doc.entities[id];
  if (!node) return null;
  const kids = flat ? [] : childrenOf(bus.doc, id);
  const isCollapsed = collapsed?.has(id) ?? false;
  function commitRename(next: string) {
    setEditing(false);
    const name = next.trim();
    if (name && node && name !== node.name) dispatch({ kind: 'rename', entity: id, name });
  }
  return (
    <>
      <div
        className={`tn${selList.includes(id) ? ' sel' : ''}${over ? ' drop' : ''}${hoverId === id ? ' hov' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        data-testid={`hier-row-${id}`}
        title={`${node.name} · #${id}${node.source ? ` · ⤴ ${node.source.plugin}` : ''}`}
        onMouseEnter={() => setHoverEntity(id)}
        onMouseLeave={() => setHoverEntity(null)}
        onClick={(e) => (e.shiftKey || e.metaKey || e.ctrlKey ? toggleSelection(id) : setSelection(id))}
        onContextMenu={(e) => {
          e.preventDefault();
          // keep an existing multi-selection if right-clicking inside it
          if (!getSelectionList().includes(id)) setSelection(id);
          onMenu({ id, x: e.clientX, y: e.clientY });
        }}
        draggable
        onDragStart={(e) => {
          draggingId = id;
          e.dataTransfer.setData('application/x-entity', String(id));
          e.dataTransfer.effectAllowed = 'move';
        }}
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
          if (draggingId !== null) reparent(draggingId, id);
          draggingId = null;
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
            defaultValue={node.name}
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
            style={node.hidden ? { opacity: 0.45 } : undefined}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            {highlight ? highlightName(node.name, highlight) : node.name}
          </span>
        )}
        <span className="comp-badges" data-testid={`hier-badges-${id}`}>
          {Object.keys(node.components).map((c) => (
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
          title={node.hidden ? 'show in viewport' : 'hide in viewport'}
          onClick={(e) => {
            e.stopPropagation();
            dispatch({ kind: 'setHidden', entity: id, hidden: !node.hidden });
          }}
        >
          {node.hidden ? '⊘' : '◉'}
        </span>
      </div>
      {!isCollapsed &&
        kids.map((k) => (
          <Row key={k} id={k} depth={depth + 1} onMenu={onMenu} collapsed={collapsed} toggleCollapse={toggleCollapse} />
        ))}
    </>
  );
}

export function HierarchyPanel() {
  const { t } = useTranslation();
  useDocVersion();
  const sel = useSelection();
  const selList = useSelectionList();
  const roots = childrenOf(bus.doc, null);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<EntityId>>(loadCollapsed);
  const toggleCollapse = (id: EntityId) =>
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
    const node = bus.doc.entities[m.id];
    const multi = getSelectionList().length > 1;
    const items: MenuItemDef[] = [];
    if (multi) {
      items.push({ label: t('editor.hierarchy.menu.group', { n: getSelectionList().length }), onClick: () => groupSelected(getSelectionList()) });
      items.push({ label: t('editor.hierarchy.menu.deleteSelected', { n: getSelectionList().length }), onClick: () => deleteManyCascade(getSelectionList()) });
      items.push({ sep: true });
    }
    items.push({ label: node?.source ? t('editor.hierarchy.menu.editSource', { plugin: node.source.plugin }) : t('editor.hierarchy.menu.editSourceNone'), disabled: !node?.source, onClick: () => { if (node?.source) openSourcePanel(node.source.plugin, node.source.docId); } });
    items.push({ label: t('editor.hierarchy.menu.duplicate'), onClick: () => duplicateEntity(m.id) });
    items.push({ label: t('editor.hierarchy.menu.copyJson'), onClick: () => { const n = bus.doc.entities[m.id]; if (n) void navigator.clipboard?.writeText(JSON.stringify({ name: n.name, components: n.components }, null, 2)); } });
    items.push({ label: t('editor.hierarchy.menu.refToChat'), onClick: () => requestRefEntity(m.id) });
    if (childrenOf(bus.doc, m.id).length > 0) items.push({ label: t('editor.hierarchy.menu.ungroup'), onClick: () => ungroupEntity(m.id) });
    items.push({ label: t('editor.hierarchy.menu.delete'), danger: true, onClick: () => deleteEntity(m.id) });
    showContextMenu({ clientX: m.x, clientY: m.y, preventDefault: () => {} }, items);
  };
  const q = query.trim().toLowerCase();
  // When filtering, flatten to all entities whose NAME or any COMPONENT name
  // matches (tree semantics dropped so deep matches surface immediately). Matching
  // by component lets a human/AI find entities by capability, e.g. "light".
  const matches = q
    ? bus.doc.order.filter((id) => {
        const n = bus.doc.entities[id];
        if (!n) return false;
        return n.name.toLowerCase().includes(q) || Object.keys(n.components).some((c) => c.toLowerCase().includes(q));
      })
    : [];
  return (
    <div className="panel" data-testid="panel-hierarchy">
      <h3>Hierarchy</h3>
      <div style={{ padding: '6px 10px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="tbtn"
          data-testid="btn-add-entity"
          onClick={() => dispatch({ kind: 'spawnEntity', name: 'Entity', parent: sel, components: { Transform: { x: 0, y: 0, z: 0 } } })}
        >
          + Entity
        </button>
        <select
          className="sel"
          data-testid="add-preset-select"
          value=""
          title="create a typed entity from a schema-default preset (Light / Camera / …)"
          onChange={(e) => {
            const preset = getPreset(e.target.value);
            if (preset) dispatch({ kind: 'spawnEntity', name: preset.label, parent: sel, components: buildPresetComponents(preset) });
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
        <button type="button" className="tbtn" data-testid="btn-duplicate" disabled={sel === null} onClick={() => sel !== null && duplicateEntity(sel)}>
          Duplicate
        </button>
        <button type="button" className="tbtn" data-testid="btn-group" disabled={selList.length < 2} onClick={() => groupSelected(getSelectionList())} title="Group selected under a new parent (Ctrl+G)">
          Group
        </button>
        <button
          type="button"
          className="tbtn"
          data-testid="btn-collapse-all"
          title="collapse / expand all parent nodes"
          onClick={() => {
            const parents = bus.doc.order.filter((id) => childrenOf(bus.doc, id).length > 0);
            const allCollapsed = parents.length > 0 && parents.every((id) => collapsed.has(id));
            const next = allCollapsed ? new Set<EntityId>() : new Set(parents);
            setCollapsed(next);
            saveCollapsed(next);
          }}
        >
          ⊟/⊞
        </button>
        <button type="button" className="tbtn" data-testid="btn-delete" disabled={sel === null} onClick={() => sel !== null && deleteEntity(sel)}>
          Delete
        </button>
      </div>
      <div style={{ padding: '0 10px 6px' }}>
        <input
          className="hier-filter"
          data-testid="hier-filter"
          placeholder="filter by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {q ? (
        <div className="tree" data-testid="hier-filtered">
          {matches.length === 0 ? (
            <div className="muted" style={{ padding: '4px 10px' }} data-testid="hier-no-match">
              no match
            </div>
          ) : (
            matches.map((id) => <Row key={id} id={id} depth={0} onMenu={openMenu} flat highlight={query.trim()} />)
          )}
        </div>
      ) : (
        <div
          className="tree"
          data-testid="hier-root-dropzone"
          onDragOver={(e) => {
            if (draggingId !== null) e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (draggingId !== null) reparent(draggingId, null);
            draggingId = null;
          }}
        >
          {roots.map((id) => (
            <Row key={id} id={id} depth={0} onMenu={openMenu} collapsed={collapsed} toggleCollapse={toggleCollapse} />
          ))}
        </div>
      )}
    </div>
  );
}
