import { useEffect, useSyncExternalStore, useState } from 'react';
import {
  Box,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Flag,
  Folder,
  Layers,
  Sun,
  Target,
  Unlock,
  User,
  Video,
  type LucideIcon,
} from 'lucide-react';
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
import { gateway, getSelection, getSelectionList, onRenameRequest, requestRefEntity, useDocVersion, useHoverEntity, useSelectionList } from '@forgeax/editor-core';
import { ENTITY_PRESETS, buildPresetComponents, getPreset } from '@forgeax/editor-core';
import type { EntityHandle } from '@forgeax/editor-core';
import {
  clearHierarchyFilters,
  clearHierarchySearchQuery,
  collapseHierarchyAll,
  getHierarchyEntityType,
  HIERARCHY_SCENE_FOLDER_ID,
  expandHierarchyAll,
  getHierarchyPanelSnapshot,
  getHierarchyVisibleMatches,
  hasHierarchyViewFilter,
  subscribeHierarchyPanelState,
  toggleHierarchyCollapsed,
  type HierarchyColumns,
} from './hierarchy-state';

interface Menu {
  id: EntityHandle;
  x: number;
  y: number;
}

// in-app drag source — more reliable than DataTransfer.getData, which is in
// "protected" mode (and empty) outside a real user drag.
let draggingId: EntityHandle | null = null;

const displayOrdinals = new Map<EntityHandle, number>();
let nextDisplayOrdinal = 0;

function stableDisplayOrder(ids: readonly EntityHandle[]): EntityHandle[] {
  for (const id of ids) {
    if (!displayOrdinals.has(id)) displayOrdinals.set(id, nextDisplayOrdinal++);
  }
  return [...ids].sort((a, b) => (displayOrdinals.get(a) ?? 0) - (displayOrdinals.get(b) ?? 0));
}

function pruneDisplayOrder(liveIds: readonly EntityHandle[]): void {
  const live = new Set(liveIds);
  for (const id of displayOrdinals.keys()) {
    if (!live.has(id)) displayOrdinals.delete(id);
  }
  if (displayOrdinals.size === 0) nextDisplayOrdinal = 0;
}

function writeDisplayOrder(ids: readonly EntityHandle[]): void {
  ids.forEach((id, index) => displayOrdinals.set(id, index));
  nextDisplayOrdinal = Math.max(nextDisplayOrdinal, ids.length);
}

function currentRootDisplayOrder(): EntityHandle[] {
  const world = gateway.activeWorld;
  return world ? stableDisplayOrder(childrenOf(world, null)) : [];
}

function moveRootDisplayOrder(movedIds: readonly EntityHandle[], target: EntityHandle | null, pos: 'before' | 'after' | 'end'): void {
  const moving = movedIds.filter((id, index) => movedIds.indexOf(id) === index);
  if (moving.length === 0) return;
  const movingSet = new Set(moving);
  const order = currentRootDisplayOrder().filter((id) => !movingSet.has(id));
  let insertAt = order.length;
  if (target !== null && pos !== 'end') {
    const targetIndex = order.indexOf(target);
    if (targetIndex >= 0) insertAt = pos === 'before' ? targetIndex : targetIndex + 1;
  }
  order.splice(insertAt, 0, ...moving);
  writeDisplayOrder(order);
}

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

function collectEntitySubtree(ids: readonly EntityHandle[]): EntityHandle[] {
  const world = gateway.activeWorld;
  if (!world) return [];
  const result: EntityHandle[] = [];
  const seen = new Set<EntityHandle>();
  const visit = (id: EntityHandle) => {
    if (seen.has(id) || !entExists(world, id)) return;
    seen.add(id);
    result.push(id);
    for (const child of childrenOf(world, id)) visit(child);
  };
  for (const id of ids) visit(id);
  return result;
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
  if (parent === null) moveRootDisplayOrder(ids, target, pos === 'before' ? 'before' : pos === 'after' ? 'after' : 'end');
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
function flatVisibleOrder(collapsed: ReadonlySet<EntityHandle>): EntityHandle[] {
  const result: EntityHandle[] = [];
  function walk(parentId: EntityHandle | null): void {
    const ids = childrenOf(gateway.activeWorld, parentId);
    for (const id of parentId === null ? stableDisplayOrder(ids) : ids) {
      result.push(id);
      if (!collapsed.has(id)) walk(id);
    }
  }
  walk(null);
  return result;
}

function handleShiftClick(id: EntityHandle, collapsed: ReadonlySet<EntityHandle>): void {
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

function hierarchyTypeToken(id: string): string {
  switch (id) {
    case 'camera': return 'CAM';
    case 'light': return 'LGT';
    case 'character': return 'CHR';
    case 'start': return 'STA';
    case 'spawner': return 'SPN';
    case 'mesh': return 'MSH';
    case 'group': return 'GRP';
    case 'folder': return 'FLD';
    default: return 'ENT';
  }
}

function hierarchyTypeIcon(id: string): LucideIcon {
  switch (id) {
    case 'camera': return Video;
    case 'light': return Sun;
    case 'character': return User;
    case 'start': return Flag;
    case 'spawner': return Target;
    case 'group': return Layers;
    case 'folder': return Folder;
    default: return Box;
  }
}

function hierarchyTypeI18nKey(id: string): string {
  switch (id) {
    case 'camera': return 'camera';
    case 'light': return 'light';
    case 'character': return 'character';
    case 'start': return 'playerStart';
    case 'spawner': return 'spawner';
    case 'mesh': return 'staticMesh';
    case 'group': return 'group';
    case 'folder': return 'folder';
    default: return 'entity';
  }
}

function hierarchyMobilityKey(components: Record<string, unknown>): 'static' | 'movable' | 'stationary' | '' {
  const explicit = Object.values(components)
    .map((component) => {
      if (typeof component !== 'object' || component === null) return undefined;
      const value = (component as { mobility?: unknown; Mobility?: unknown }).mobility
        ?? (component as { mobility?: unknown; Mobility?: unknown }).Mobility;
      return typeof value === 'string' ? value : undefined;
    })
    .find(Boolean);
  const normalized = explicit?.toLowerCase();
  if (normalized === 'static' || normalized === 'movable' || normalized === 'stationary') return normalized;
  if ('RigidBody' in components || 'Rigidbody' in components) return 'movable';
  if ('Transform' in components) return 'static';
  return '';
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
  columns,
}: {
  id: EntityHandle;
  depth: number;
  onMenu: (m: Menu) => void;
  flat?: boolean | undefined;
  collapsed?: ReadonlySet<EntityHandle> | undefined;
  toggleCollapse?: ((id: EntityHandle) => void) | undefined;
  highlight?: string | undefined;
  readOnly?: boolean | undefined;
  columns: HierarchyColumns;
}) {
  const { t } = useTranslation();
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
  const actualKids = childrenOf(world, id);
  const kids = flat ? [] : actualKids;
  const entityType = getHierarchyEntityType(world, id);
  const typeLabel = t(`editor.hierarchy.types.${hierarchyTypeI18nKey(entityType.id)}`);
  const typeToken = hierarchyTypeToken(entityType.id);
  const mobilityKey = hierarchyMobilityKey(nodeComponents);
  const mobilityLabel = mobilityKey ? t(`editor.hierarchy.mobility.${mobilityKey}`) : '';
  const TypeIcon = hierarchyTypeIcon(entityType.id);
  const isCollapsed = collapsed?.has(id) ?? false;
  function commitRename(next: string) {
    setEditing(false);
    const name = next.trim();
    if (name && name !== nodeName) gateway.dispatch({ kind: 'rename', entity: id, name });
  }
  return (
    <>
      <div
        className={`tn k-${typeToken.toLowerCase()}${selList.has(id) ? ' sel' : ''}${nodeHidden ? ' dim' : ''}${dropPos === 'inside' ? ' drop' : ''}${dropPos === 'before' ? ' drop-before' : ''}${dropPos === 'after' ? ' drop-after' : ''}${hoverId === id ? ' hov' : ''}`}
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
          className={`eye${nodeHidden ? ' off' : ''}`}
          data-testid={`hier-vis-${id}`}
          title={nodeHidden ? t('editor.hierarchy.menu.showInViewport') : t('editor.hierarchy.menu.hideInViewport')}
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
          {nodeHidden ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
        </span>
        <span className="lock" title={t('editor.hierarchy.menu.lockUnavailable')} aria-disabled="true">
          <Unlock size={12} aria-hidden="true" />
        </span>
        <span className="name-cell" style={{ paddingLeft: depth * 15 }}>
          <span
            className="caret"
            data-testid={`hier-toggle-${id}`}
            onClick={(e) => {
              if (!kids.length) return;
              e.stopPropagation();
              toggleCollapse?.(id);
            }}
            style={kids.length ? { cursor: 'pointer' } : undefined}
          >
            {kids.length ? (
              isCollapsed ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />
            ) : <span className="leafdot" />}
          </span>
          <span className="ico" aria-hidden="true">
            <TypeIcon size={15} />
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
              className="nm"
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (!readOnly) setEditing(true);
              }}
            >
              {highlight ? highlightName(nodeName, highlight) : nodeName}
            </span>
          )}
          {kids.length > 0 && (
            <span
              className="cbadge"
              data-testid={`hier-count-${id}`}
              title={t('editor.hierarchy.childCount', { count: kids.length })}
            >
              {kids.length}
            </span>
          )}
        </span>
        {columns.type && (
          <span className="cell type col-type">
            {entityType.id === 'group' ? <span className="kind">{typeLabel}</span> : typeLabel}
          </span>
        )}
        {columns.mobility && <span className={`cell mob col-mob mob-${mobilityKey || 'none'}`}>{mobilityLabel}</span>}
        {columns.id && <span className="cell id col-id" title={`Entity #${id}`}>{id}</span>}
      </div>
      {!isCollapsed &&
        kids.map((k) => (
          <Row key={k} id={k} depth={depth + 1} onMenu={onMenu} collapsed={collapsed} toggleCollapse={toggleCollapse} readOnly={readOnly} columns={columns} />
        ))}
    </>
  );
}

// An always-present drop target at the top of the tree for "move to root"
// (P0-5). Dragging a node onto it makes the node a sibling of the top-level
// nodes — the reliable path when the tree is full and there is no reachable
// empty area to drop into. Highlights only while a drag is in progress.
function RootDropBar({ readOnly }: { readOnly: boolean }) {
  const { t } = useTranslation();
  const [over, setOver] = useState(false);
  if (readOnly) return null;
  return (
    <div
      className={`hier-root-bar${over ? ' over' : ''}`}
      data-testid="hier-root-bar"
      title={t('editor.hierarchy.menu.moveToRoot')}
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
        moveRootDisplayOrder(ids, null, 'end');
        if (ids.length > 1) reparentMany(ids, null);
        else if (ids[0] !== undefined) reparent(ids[0], null);
        draggingId = null;
      }}
    >
    </div>
  );
}

function SceneFolderRow({
  childrenIds,
  visibilityIds,
  filtered,
  highlight,
  onMenu,
  onBlankMenu,
  collapsed,
  toggleCollapse,
  readOnly,
  columns,
}: {
  childrenIds: readonly EntityHandle[];
  visibilityIds?: readonly EntityHandle[] | undefined;
  filtered?: boolean | undefined;
  highlight?: string | undefined;
  onMenu: (m: Menu) => void;
  onBlankMenu: (x: number, y: number) => void;
  collapsed: ReadonlySet<EntityHandle>;
  toggleCollapse: (id: EntityHandle) => void;
  readOnly: boolean;
  columns: HierarchyColumns;
}) {
  const { t } = useTranslation();
  const [dropPos, setDropPos] = useState<DropPos | null>(null);
  const isCollapsed = !filtered && collapsed.has(HIERARCHY_SCENE_FOLDER_ID);
  const sceneLabel = t('editor.hierarchy.sceneRoot');
  const folderTypeLabel = t('editor.hierarchy.types.folder');
  const visibilityTargets = collectEntitySubtree(visibilityIds ?? childrenIds);
  const folderHidden = visibilityTargets.length > 0
    && visibilityTargets.every((id) => entComponent(gateway.activeWorld, id, 'EditorHidden').ok);
  const setFolderHidden = (hidden: boolean) => {
    if (readOnly) return;
    for (const id of visibilityTargets) {
      const currentlyHidden = entComponent(gateway.activeWorld, id, 'EditorHidden').ok;
      if (currentlyHidden !== hidden) gateway.dispatch({ kind: 'setHidden', entity: id, hidden });
    }
  };
  return (
    <>
      <div
        className={`tn k-folder${folderHidden ? ' dim' : ''}${dropPos === 'inside' ? ' drop' : ''}`}
        data-testid="hier-row-scene-folder"
        title={sceneLabel}
        onClick={(e) => {
          e.stopPropagation();
          if (!filtered) toggleCollapse(HIERARCHY_SCENE_FOLDER_ID);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onBlankMenu(e.clientX, e.clientY);
        }}
        onDragOver={(e) => {
          if (draggingId === null || readOnly) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (dropPos !== 'inside') setDropPos('inside');
        }}
        onDragLeave={() => setDropPos(null)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDropPos(null);
          if (draggingId !== null && !readOnly) {
            const ids = draggedIds();
            moveRootDisplayOrder(ids, null, 'end');
            if (ids.length > 1) reparentMany(ids, null);
            else if (ids[0] !== undefined) reparent(ids[0], null);
          }
          draggingId = null;
        }}
      >
        <span
          className={`eye${folderHidden ? ' off' : ''}`}
          data-testid="hier-vis-scene-folder"
          title={folderHidden ? t('editor.hierarchy.menu.showFolderContents') : t('editor.hierarchy.menu.hideFolderContents')}
          onClick={(e) => {
            e.stopPropagation();
            setFolderHidden(!folderHidden);
          }}
        >
          {folderHidden ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
        </span>
        <span className="lock" title={t('editor.hierarchy.menu.folderDisplayOnly')}>
          <Unlock size={12} aria-hidden="true" />
        </span>
        <span className="name-cell">
          <span className="caret" data-testid="hier-toggle-scene-folder">
            {isCollapsed ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
          </span>
          <span className="ico" aria-hidden="true">
            <Folder size={15} />
          </span>
          <span className="nm">{sceneLabel}</span>
        </span>
        {columns.type && <span className="cell type col-type"><span className="kind">{folderTypeLabel}</span></span>}
        {columns.mobility && <span className="cell mob col-mob" />}
        {columns.id && <span className="cell id col-id" />}
      </div>
      {!isCollapsed && childrenIds.map((id) => (
        <Row
          key={id}
          id={id}
          depth={1}
          onMenu={onMenu}
          flat={filtered}
          collapsed={collapsed}
          toggleCollapse={toggleCollapse}
          highlight={highlight}
          readOnly={readOnly}
          columns={columns}
        />
      ))}
    </>
  );
}

export function HierarchyPanel() {
  const { t } = useTranslation();
  useDocVersion();
  const view = useSyncExternalStore(
    subscribeHierarchyPanelState,
    getHierarchyPanelSnapshot,
    getHierarchyPanelSnapshot,
  );
  // Play mode makes the active world a read-only simulation view: document ops
  // are rejected at the gateway (`edit-rejected-in-play`). Disable the editing
  // controls so they don't silently no-op (P0-4). enterPlay/exitPlay emit, so
  // useDocVersion re-renders this on mode change.
  const readOnly = gateway.mode === 'play';
  const activeWorld = gateway.activeWorld;
  const worldReady = activeWorld != null;
  if (worldReady) pruneDisplayOrder(worldEntityHandles(activeWorld));
  const roots = worldReady ? stableDisplayOrder(childrenOf(activeWorld, null)) : [];
  const collapsed = view.collapsed;
  const toggleCollapse = (id: EntityHandle) => toggleHierarchyCollapsed(id);
  const spawnEntity = () => {
    if (readOnly) return;
    gateway.dispatch({
      kind: 'spawnEntity',
      name: 'Entity',
      parent: getSelection(),
      components: { Transform: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    });
  };
  const spawnPreset = (label: string) => {
    if (readOnly) return;
    const preset = getPreset(label);
    if (!preset) return;
    gateway.dispatch({
      kind: 'spawnEntity',
      name: preset.label,
      parent: getSelection(),
      components: buildPresetComponents(preset),
    });
  };
  const selectAll = () => {
    if (!gateway.activeWorld) return;
    gateway.dispatch({ kind: 'setSelectionMany', ids: worldEntityHandles(gateway.activeWorld) });
  };
  const showAll = () => {
    if (!gateway.activeWorld || readOnly) return;
    for (const id of worldEntityHandles(gateway.activeWorld)) {
      if (entComponent(gateway.activeWorld, id, 'EditorHidden').ok) {
        gateway.dispatch({ kind: 'setHidden', entity: id, hidden: false });
      }
    }
  };
  const clearViewFilters = () => {
    clearHierarchySearchQuery();
    clearHierarchyFilters();
  };
  const focusSelectionInViewport = () => {
    if (getSelection() !== null) gateway.dispatch({ kind: 'requestFrame' });
  };
  const createMenuItems = (): MenuItemDef[] => [
    { label: t('editor.hierarchy.menu.createEntity'), icon: 'file-plus', onClick: spawnEntity, disabled: readOnly },
    ...ENTITY_PRESETS.map((preset) => ({
      label: t('editor.hierarchy.menu.createPreset', { label: preset.label }),
      icon: 'box',
      onClick: () => spawnPreset(preset.label),
      disabled: readOnly,
    })),
    { label: t('editor.hierarchy.menu.newFolder'), icon: 'folder-plus', disabled: true },
    {
      label: t('editor.hierarchy.menu.newGroup'),
      icon: 'layers',
      onClick: () => groupSelected([...getSelectionList()]),
      disabled: readOnly || getSelectionList().size < 2,
    },
  ];
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
    items.push({ label: t('editor.hierarchy.menu.create'), icon: 'folder-plus', children: createMenuItems() });
    items.push({ sep: true });
    if (multi) {
      items.push({ label: t('editor.hierarchy.menu.group', { n: snapshot.length }), icon: 'layers', onClick: () => groupSelected(snapshot) });
      items.push({ label: t('editor.hierarchy.menu.deleteSelected', { n: snapshot.length }), icon: 'trash-2', onClick: () => deleteManyCascade(snapshot) });
      items.push({ sep: true });
    }
    items.push({ label: t('editor.hierarchy.menu.rename'), icon: 'pencil', shortcut: 'F2', onClick: () => gateway.dispatch({ kind: 'requestRename', entity: m.id }), disabled: readOnly });
    items.push({ label: t('editor.hierarchy.menu.duplicate'), icon: 'copy', shortcut: 'Ctrl+D', onClick: () => duplicateEntity(m.id) });
    items.push({ label: t('editor.hierarchy.menu.copyJson'), icon: 'braces', onClick: () => { if (entExists(gateway.activeWorld, m.id)) void navigator.clipboard?.writeText(JSON.stringify({ id: m.id, name: entName(gateway.activeWorld, m.id), components: entComponents(gateway.activeWorld, m.id) }, null, 2)); } });
    items.push({ label: t('editor.hierarchy.menu.refToChat'), icon: 'spark', forge: true, shortcut: 'Ctrl+K', onClick: () => requestRefEntity(m.id) });
    if (childrenOf(gateway.activeWorld, m.id).length > 0) items.push({ label: t('editor.hierarchy.menu.ungroup'), icon: 'layers', onClick: () => ungroupEntity(m.id) });
    const hidden = entComponent(gateway.activeWorld, m.id, 'EditorHidden').ok;
    items.push({ sep: true });
    items.push({ label: hidden ? t('editor.hierarchy.menu.show') : t('editor.hierarchy.menu.hide'), icon: 'eye', onClick: () => gateway.dispatch({ kind: 'setHidden', entity: m.id, hidden: !hidden }), disabled: readOnly });
    items.push({ label: t('editor.hierarchy.menu.focusViewport'), icon: 'crosshair', shortcut: 'F', onClick: focusSelectionInViewport });
    items.push({ label: t('editor.hierarchy.menu.lock'), icon: 'shield-check', disabled: true });
    items.push({ label: t('editor.hierarchy.menu.moveTo'), icon: 'folder', disabled: true });
    items.push({ sep: true });
    items.push({ label: t('editor.hierarchy.menu.delete'), icon: 'trash-2', shortcut: 'Del', danger: true, onClick: () => { multi ? deleteManyCascade(snapshot) : deleteEntity(m.id); } });
    showContextMenu({ clientX: m.x, clientY: m.y, preventDefault: () => {} }, items);
  };
  const openBlankMenu = (x: number, y: number) => {
    const items: MenuItemDef[] = [
      { label: t('editor.hierarchy.menu.create'), icon: 'folder-plus', children: createMenuItems() },
      { sep: true },
      { label: t('editor.hierarchy.menu.paste'), icon: 'copy', shortcut: 'Ctrl+V', disabled: true },
      { label: t('editor.hierarchy.menu.selectAll'), icon: 'box-select', shortcut: 'Ctrl+A', onClick: selectAll },
      { label: t('editor.hierarchy.menu.deselect'), icon: 'crosshair', onClick: () => gateway.dispatch({ kind: 'setSelection', id: null }) },
      { sep: true },
      { label: t('editor.hierarchy.menu.expandAll'), icon: 'chevrons-up-down', onClick: expandHierarchyAll },
      { label: t('editor.hierarchy.menu.collapseAll'), icon: 'chevrons-down-up', onClick: collapseHierarchyAll },
      { label: t('editor.hierarchy.menu.clearSearchFilters'), icon: 'folder-search', onClick: clearViewFilters, disabled: !hasHierarchyViewFilter() },
      { sep: true },
      { label: t('editor.hierarchy.menu.showAll'), icon: 'eye', onClick: showAll, disabled: readOnly },
      { label: t('editor.hierarchy.menu.focusSelection'), icon: 'crosshair', shortcut: 'F', onClick: focusSelectionInViewport, disabled: getSelection() === null },
      { label: t('editor.hierarchy.menu.refreshOutliner'), icon: 'refresh-cw', disabled: true },
    ];
    showContextMenu({ clientX: x, clientY: y, preventDefault: () => {} }, items);
  };
  // When filtering, flatten to all entities whose NAME or any COMPONENT name
  // matches (tree semantics dropped so deep matches surface immediately). Matching
  // by component lets a human/AI find entities by capability, e.g. "light".
  // M7 / AC-15: entity list + name/components come from world (SSOT) via
  // entity-state; doc.order/doc.entities deleted.
  const filtering = hasHierarchyViewFilter();
  const matches = filtering && worldReady ? stableDisplayOrder(getHierarchyVisibleMatches()) : [];

  // Cross-game switch gap: show a quiet placeholder until createApp reinjects doc.world.
  if (!worldReady) {
    return (
      <div className="panel outliner-panel" data-testid="panel-hierarchy" data-world-gap="1" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="muted" data-testid="hier-world-gap" style={{ padding: '12px 10px' }}>
          {t('editor.hierarchy.switchingGame')}
        </div>
      </div>
    );
  }

  return (
    <div
      className="panel outliner-panel"
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
      <div className="ol-colhead" data-testid="hier-colhead">
        <span className="ch-eye" />
        <span className="ch-lock" />
        <span className="ch-name sortable">{t('editor.hierarchy.columns.name')}</span>
        {view.columns.type && <span className="ch-type sortable col-type">{t('editor.hierarchy.columns.type')}</span>}
        {view.columns.mobility && <span className="ch-mob sortable col-mob">{t('editor.hierarchy.columns.mobilityShort')}</span>}
        {view.columns.id && <span className="ch-id sortable col-id">{t('editor.hierarchy.columns.id')}</span>}
      </div>
      {filtering ? (
        <div
          className="ol-body"
          data-testid="hier-filtered"
          style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest('.tn')) return;
            openBlankMenu(e.clientX, e.clientY);
          }}
        >
          {matches.length === 0 ? (
            <div className="muted" style={{ padding: '4px 10px' }} data-testid="hier-no-match">
              {t('editor.hierarchy.noMatch')}
            </div>
          ) : (
            <SceneFolderRow
              childrenIds={matches}
              visibilityIds={roots}
              filtered
              highlight={view.searchQuery.trim()}
              onMenu={openMenu}
              onBlankMenu={openBlankMenu}
              collapsed={collapsed}
              toggleCollapse={toggleCollapse}
              readOnly={readOnly}
              columns={view.columns}
            />
          )}
        </div>
      ) : (
        <div
          className="ol-body"
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
              moveRootDisplayOrder(ids, null, 'end');
              if (ids.length > 1) reparentMany(ids, null);
              else if (ids[0] !== undefined) reparent(ids[0], null);
            }
            draggingId = null;
          }}
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest('.tn')) return;
            openBlankMenu(e.clientX, e.clientY);
          }}
        >
          <RootDropBar readOnly={readOnly} />
          <SceneFolderRow
            childrenIds={roots}
            visibilityIds={roots}
            onMenu={openMenu}
            onBlankMenu={openBlankMenu}
            collapsed={collapsed}
            toggleCollapse={toggleCollapse}
            readOnly={readOnly}
            columns={view.columns}
          />
        </div>
      )}
    </div>
  );
}
