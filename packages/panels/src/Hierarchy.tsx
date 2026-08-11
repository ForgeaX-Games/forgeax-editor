import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
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
  User,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { useKeybindingScope } from '@forgeax/interface/core/app-shell';
import { showContextMenu, type MenuItemDef } from '@forgeax/editor-core';
import { childrenOf } from '@forgeax/editor-core';
import { entExists, entName, entParent, entComponents, entComponentsPresent, worldComponentNames, worldEntityHandles } from '@forgeax/editor-core';
// M3 (AC-03, plan-strategy §2 D-6): all state mutations go through the one
// gateway door — `gateway.dispatch({ kind, … })` — instead of the old direct store
// setters (setSelection/setHoverEntity/toggleSelection) or the origin-less
// `dispatch` wrapper. Default origin is 'human' (D-6); the payload is the same
// plain-JSON op the AI would build. "Change the door, not the body."
// M3 (I1/AC-08/AC-09): all reads go through gateway.activeWorld (edit->editWorld,
// play->playWorld) + EntityHandle; node key IS the engine handle.
import { dispatchActiveEditorOperation, gateway, getActiveRuntimeUiGraph, getSelection, getSelectionList, onSelectionChange, onRenameRequest, readEntityVisibility, readVisibilityIntent, requestRefEntity, resolveVisibility, subscribeDocVersion, useDocVersion, useIsHoverEntity, useIsSelected, useSelection, useSceneReadModel, clearAssetSelection, clearFolderSelection, getViewportRuntimeClientSnapshot, queryViewportRuntimeProjection, subscribeViewportRuntimeClient } from '@forgeax/editor-core';
import { ENTITY_PRESETS, buildPresetComponents, getPreset } from '@forgeax/editor-core';
import type { EntityHandle, VisibilitySnapshot } from '@forgeax/editor-core';
import {
  clearHierarchyFilters,
  clearHierarchySearchQuery,
  collapseHierarchyAll,
  getHierarchyEntityType,
  hierarchyTypeCategory,
  componentTypeLabel,
  HIERARCHY_GROUP_TYPE_ID,
  HIERARCHY_SCENE_FOLDER_ID,
  expandHierarchyAll,
  expandHierarchySceneFolder,
  getHierarchyPanelSnapshot,
  hierarchyMobility,
  getHierarchyVisibleMatches,
  createHierarchyStructureSelector,
  type HierarchyStructureProjection,
  hasHierarchyViewFilter,
  revealHierarchyEntity,
  subscribeHierarchyPanelState,
  toggleHierarchyCollapsed,
  type HierarchyColumns,
  type HierarchyRuntimeProjection,
} from './hierarchy-state';

interface Menu {
  id: EntityHandle;
  x: number;
  y: number;
}

// Handle → component-name list for the whole active world, built ONCE per
// HierarchyPanel render (worldComponentNames, zero Error) and threaded down so a
// Row derives its type / hidden / mobility from a cheap lookup instead of the
// O(all-registered-components) entComponents probe that ran per row per render.
type CompNameIndex = ReadonlyMap<EntityHandle, readonly string[]>;
const EMPTY_COMP_INDEX: CompNameIndex = new Map();
const EMPTY_NAMES: readonly string[] = [];
const EMPTY_IDS: readonly EntityHandle[] = [];

export interface HierarchyCommandActions {
  readonly canMutateFocusedTarget: boolean;
  readonly canRenameFocusedTarget: boolean;
  readonly renameFocused: () => void;
  readonly deleteFocused: () => void;
  readonly selectAll: () => void;
}

export interface HierarchyCommandActionDeps {
  readonly readOnly: boolean;
  readonly getFocusedEntity: () => EntityHandle | null;
  readonly getSelectedEntities: () => EntityHandle[];
  readonly renameEntity: (entity: EntityHandle) => void;
  readonly deleteEntities: (entities: readonly EntityHandle[]) => void;
  readonly selectAll: () => void;
}

export function createHierarchyCommandActions(
  deps: HierarchyCommandActionDeps,
): HierarchyCommandActions {
  const focusedEntities = (): EntityHandle[] => {
    const selection = deps.getSelectedEntities();
    const focused = deps.getFocusedEntity();
    if (focused === null) return selection;
    return selection.includes(focused) ? selection : [focused];
  };
  return {
    get canMutateFocusedTarget() {
      return !deps.readOnly && focusedEntities().length > 0;
    },
    get canRenameFocusedTarget() {
      return !deps.readOnly
        && (deps.getFocusedEntity() !== null || deps.getSelectedEntities().length > 0);
    },
    renameFocused() {
      if (deps.readOnly) return;
      const target = deps.getFocusedEntity() ?? deps.getSelectedEntities().at(-1) ?? null;
      if (target !== null) deps.renameEntity(target);
    },
    deleteFocused() {
      if (deps.readOnly) return;
      const targets = focusedEntities();
      if (targets.length > 0) deps.deleteEntities(targets);
    },
    selectAll: deps.selectAll,
  };
}

let focusedHierarchyEntity: EntityHandle | null = null;
let hierarchyCommandActions: HierarchyCommandActions | null = null;

export function getHierarchyCommandActions(): HierarchyCommandActions | null {
  return hierarchyCommandActions;
}

type HierarchyOperation = Parameters<typeof gateway.dispatch>[0];
interface RemoteHierarchyContextValue {
  readonly selectionIds: ReadonlySet<EntityHandle>;
  readonly primarySelection: EntityHandle | null;
  readonly structure: HierarchyStructureProjection;
}
const RemoteHierarchyContext = createContext<RemoteHierarchyContextValue | null>(null);

function dispatchHierarchyOperation(operation: HierarchyOperation): void {
  void dispatchActiveEditorOperation(operation);
}

// A referentially STABLE callback that always invokes the latest closure — the
// `useEvent` idiom (React RFC). The right-click/collapse handlers close over the
// per-render `t`/`readOnly`/world reads, but must NOT change identity every
// render, or they would defeat the memo() on every Row/SceneFolderRow (a single
// panel re-render would otherwise re-render the whole tree). Refs are exempt from
// dependency tracking, so the returned function is created once and never bust
// downstream shallow-prop comparison.
function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
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
function draggedIds(remote: RemoteHierarchyContextValue | null = null): EntityHandle[] {
  if (draggingId === null) return [];
  const sel = remote?.selectionIds ?? getSelectionList();
  return sel.has(draggingId) ? [...sel] : [draggingId];
}

function projectedParent(structure: HierarchyStructureProjection, id: EntityHandle): EntityHandle | null {
  return structure.rows.find((row) => row.childIds.includes(id))?.id ?? null;
}

function collectEntitySubtree(
  ids: readonly EntityHandle[],
  projection?: HierarchyStructureProjection,
): EntityHandle[] {
  if (projection !== undefined) {
    const children = new Map(projection.rows.map((row) => [row.id, row.childIds] as const));
    const result: EntityHandle[] = [];
    const seen = new Set<EntityHandle>();
    const visit = (id: EntityHandle) => {
      if (seen.has(id)) return;
      seen.add(id);
      result.push(id);
      for (const child of children.get(id) ?? EMPTY_IDS) visit(child);
    };
    for (const id of ids) visit(id);
    return result;
  }
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
function applyDrop(target: EntityHandle, pos: DropPos, remote: RemoteHierarchyContextValue | null): void {
  const ids = draggedIds(remote);
  if (ids.length === 0) return;
  const parent = pos === 'inside'
    ? target
    : remote === null
      ? entParent(gateway.activeWorld, target)
      : projectedParent(remote.structure, target);
  if (parent === null) moveRootDisplayOrder(ids, target, pos === 'before' ? 'before' : pos === 'after' ? 'after' : 'end');
  void dispatchActiveEditorOperation({ kind: 'hierarchyGesture', action: 'reparent', entities: ids, parent });
}

// Shift+range selection anchor — the last explicitly clicked node (plain click
// or Ctrl+click). Purely a Hierarchy UI concept; not stored in the selection
// store (different panels could have different anchor semantics).
let anchorId: EntityHandle | null = null;

/** Walk the tree in display order, skipping collapsed subtrees. */
function flatVisibleOrder(
  collapsed: ReadonlySet<EntityHandle>,
  projection?: HierarchyStructureProjection,
): EntityHandle[] {
  const projectedChildren = projection
    ? new Map(projection.rows.map((row) => [row.id, row.childIds] as const))
    : undefined;
  const projectedChildIds = projection
    ? new Set(projection.rows.flatMap((row) => row.childIds))
    : undefined;
  const result: EntityHandle[] = [];
  function walk(parentId: EntityHandle | null): void {
    const ids = projectedChildren
      ? parentId === null
        ? projection!.rows.filter((row) => !projectedChildIds!.has(row.id)).map((row) => row.id)
        : projectedChildren.get(parentId) ?? EMPTY_IDS
      : childrenOf(gateway.activeWorld, parentId);
    for (const id of parentId === null ? stableDisplayOrder(ids) : ids) {
      result.push(id);
      if (!collapsed.has(id)) walk(id);
    }
  }
  walk(null);
  return result;
}

function handleShiftClick(
  id: EntityHandle,
  collapsed: ReadonlySet<EntityHandle>,
  remote: RemoteHierarchyContextValue | null,
): void {
  const anchor = anchorId ?? remote?.primarySelection ?? getSelection();
  if (anchor === null) {
    dispatchHierarchyOperation({ kind: 'setSelection', id });
    anchorId = id;
    return;
  }
  const order = flatVisibleOrder(collapsed, remote?.structure);
  const ai = order.indexOf(anchor);
  const ci = order.indexOf(id);
  if (ai < 0 || ci < 0) {
    dispatchHierarchyOperation({ kind: 'setSelection', id });
    anchorId = id;
    return;
  }
  const lo = Math.min(ai, ci);
  const hi = Math.max(ai, ci);
  const range = order.slice(lo, hi + 1);
  dispatchHierarchyOperation({ kind: 'setSelectionMany', ids: range });
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

// Row CSS class token `k-<token>`: only k-grp / k-folder carry styling (dimmed
// name); the rest are inert, so 'gen' for arbitrary components is harmless.
function hierarchyTypeToken(id: string): string {
  switch (hierarchyTypeCategory(id)) {
    case 'camera': return 'cam';
    case 'light': return 'lgt';
    case 'character': return 'chr';
    case 'start': return 'sta';
    case 'spawner': return 'spn';
    case 'mesh': return 'msh';
    case 'group': return 'grp';
    case 'entity': return 'ent';
    default: return 'gen';
  }
}

function hierarchyTypeIcon(id: string): LucideIcon {
  switch (hierarchyTypeCategory(id)) {
    case 'camera': return Video;
    case 'light': return Sun;
    case 'character': return User;
    case 'start': return Flag;
    case 'spawner': return Target;
    case 'group': return Layers;
    default: return Box; // mesh, generic components, and bare entities
  }
}

// ── Per-row value-stable snapshot ────────────────────────────────────────────
// A Row's rendered output depends ONLY on this small structural view-model — not
// on transform values or any other frame-volatile world state. We therefore let
// each Row subscribe to the raw doc-change signal (which ▶ Play bumps every
// frame) but return a value-COMPARED snapshot: if the entity's name / type /
// hidden / mobility / child set are unchanged, getSnapshot returns the SAME
// object reference, so useSyncExternalStore bails on Object.is and the Row does
// NOT re-render. This is why a 60fps doc churn costs zero row re-renders while a
// real rename still repaints exactly the one row that changed. Passing a
// whole-tree Map down as a prop (the previous approach) defeated this: the Map
// ref changed every frame, busting memo() on every Row.
interface HierarchyRowVM {
  readonly exists: boolean;
  readonly name: string;
  readonly typeId: string;
  readonly hidden: boolean;
  /** An ancestor's hidden Visibility intent reaches this row while its own
   *  intent remains inherited, so the row renders dimmed. */
  readonly ancestorHidden: boolean;
  readonly mobilityKey: ReturnType<typeof hierarchyMobility>;
  readonly childIds: readonly EntityHandle[];
}
const MISSING_ROW_VM: HierarchyRowVM = {
  exists: false, name: '', typeId: '', hidden: false, ancestorHidden: false, mobilityKey: '', childIds: EMPTY_IDS,
};
// One component-name index per doc change, rebuilt lazily the first time any row
// reads a snapshot after a change (dirty flag) — so a 60fps churn rebuilds the
// index once, not once per mounted row.
let rowVmDirty = true;
let rowVmCompIndex: CompNameIndex = EMPTY_COMP_INDEX;
const rowVmCache = new Map<EntityHandle, HierarchyRowVM>();

function idsEqual(a: readonly EntityHandle[], b: readonly EntityHandle[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function rowVmEqual(a: HierarchyRowVM, b: HierarchyRowVM): boolean {
  return a.exists === b.exists
    && a.name === b.name
    && a.typeId === b.typeId
    && a.hidden === b.hidden
    && a.ancestorHidden === b.ancestorHidden
    && a.mobilityKey === b.mobilityKey
    && idsEqual(a.childIds, b.childIds);
}
// Rebuilt alongside the component-name index: the engine's immutable
// Visibility snapshot resolves inherited state for every row in one pass.
let rowVmVisibility: VisibilitySnapshot | undefined;
function rowVmSnapshot(id: EntityHandle): HierarchyRowVM {
  if (rowVmDirty) {
    rowVmDirty = false;
    const w = gateway.activeWorld;
    rowVmCompIndex = w ? worldComponentNames(w) : EMPTY_COMP_INDEX;
    rowVmVisibility = w ? resolveVisibility(w) : undefined;
  }
  const prev = rowVmCache.get(id);
  const world = gateway.activeWorld;
  if (world == null || !entExists(world, id)) {
    if (prev && !prev.exists) return prev;
    rowVmCache.set(id, MISSING_ROW_VM);
    return MISSING_ROW_VM;
  }
  const names = rowVmCompIndex.get(id) ?? EMPTY_NAMES;
  const resolution = rowVmVisibility
    ? readEntityVisibility(world, id, rowVmVisibility)
    : readEntityVisibility(world, id);
  const candidate: HierarchyRowVM = {
    exists: true,
    name: entName(world, id),
    typeId: getHierarchyEntityType(names, world, id).id,
    hidden: resolution.intent === 'hidden',
    ancestorHidden: resolution.effective === 'hidden' && resolution.intent !== 'hidden',
    mobilityKey: hierarchyMobility(entComponentsPresent(world, id, names)),
    childIds: childrenOf(world, id),
  };
  if (prev && rowVmEqual(prev, candidate)) return prev;
  rowVmCache.set(id, candidate);
  return candidate;
}
function subscribeRowVm(fn: () => void): () => void {
  // Any doc change (incl. per-frame Play mirror) marks the shared index dirty
  // and pings the row; the value-compared snapshot then decides whether the row
  // actually re-renders.
  return subscribeDocVersion(() => {
    rowVmDirty = true;
    fn();
  });
}
const projectionVmCache = new WeakMap<object, Map<EntityHandle, HierarchyRowVM>>();
function useHierarchyRowVM(id: EntityHandle, projection?: HierarchyStructureProjection): HierarchyRowVM {
  const getSnapshot = useCallback(() => projection ? (projectionRow(projection, id) ?? MISSING_ROW_VM) : rowVmSnapshot(id), [id, projection]);
  const subscribe = useCallback((listener: () => void) => projection ? (() => undefined) : subscribeRowVm(listener), [projection]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
// Per-row collapse subscription: toggling one node's collapse re-renders only
// the rows whose own collapsed flag flips, not the whole tree.
function useIsHierarchyCollapsed(id: EntityHandle): boolean {
  const getSnapshot = useCallback(() => getHierarchyPanelSnapshot().collapsed.has(id), [id]);
  return useSyncExternalStore(subscribeHierarchyPanelState, getSnapshot, getSnapshot);
}
// Collapse an id list to a stable reference across renders: while ▶ Play bumps
// docVersion every frame, the root order rarely changes, so returning the prior
// array when contents are value-equal keeps the SceneFolderRow memo intact.
function useStableIds(ids: readonly EntityHandle[]): readonly EntityHandle[] {
  const ref = useRef(ids);
  if (!idsEqual(ref.current, ids)) ref.current = ids;
  return ref.current;
}

interface HierarchyVisibleRow {
  readonly id: EntityHandle;
  readonly depth: number;
}

/**
 * Flatten the visible tree for the viewport without changing the authored
 * hierarchy. The old recursive renderer created one Row fiber for every
 * expanded entity; the flat projection is the input to the row virtualizer.
 */
function flattenVisibleRows(
  roots: readonly EntityHandle[],
  collapsed: ReadonlySet<EntityHandle>,
  world: typeof gateway.activeWorld,
  projection?: HierarchyStructureProjection,
): HierarchyVisibleRow[] {
  const childrenById = projection
    ? new Map(projection.rows.map((row) => [row.id, row.childIds] as const))
    : undefined;
  const childrenOfId = (id: EntityHandle): readonly EntityHandle[] =>
    childrenById?.get(id) ?? (world ? childrenOf(world, id) : EMPTY_IDS);
  const pending: HierarchyVisibleRow[] = [];
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    pending.push({ id: roots[i]!, depth: 1 });
  }
  const rows: HierarchyVisibleRow[] = [];
  while (pending.length > 0) {
    const row = pending.pop()!;
    rows.push(row);
    if (collapsed.has(row.id)) continue;
    const children = childrenOfId(row.id);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      pending.push({ id: children[i]!, depth: row.depth + 1 });
    }
  }
  return rows;
}

function useRemoteHierarchyProjection(): HierarchyRuntimeProjection | undefined {
  const connection = useSyncExternalStore(
    subscribeViewportRuntimeClient,
    getViewportRuntimeClientSnapshot,
    getViewportRuntimeClientSnapshot,
  );
  const [projection, setProjection] = useState<HierarchyRuntimeProjection | undefined>();
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
        const envelope = await queryViewportRuntimeProjection<HierarchyRuntimeProjection>({ kind: 'hierarchy.structure' });
        if (disposed) return;
        if (envelope.status === 'ready') setProjection(envelope.value);
        else if (envelope.status === 'empty') setProjection({
          structure: { structureEpoch: envelope.revision, rows: [] },
          selectionIds: [],
          mode: 'edit',
        });
        else setProjection(undefined);
      } catch {
        if (!disposed) setProjection(undefined);
      } finally {
        pending = false;
      }
    };
    void refresh();
    // Bounded pull keeps the cache disposable and avoids inventing a second
    // notification protocol before measurement demonstrates that deltas pay off.
    const timer = window.setInterval(() => void refresh(), 100);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [connection.runtime?.runtimeId, connection.runtime?.runtimeGeneration, connection.status]);
  return projection;
}

function useHierarchyProjection(): {
  readonly structure: HierarchyStructureProjection | undefined;
  readonly remote: HierarchyRuntimeProjection | undefined;
} {
  const remoteProjection = useRemoteHierarchyProjection();
  const graph = getActiveRuntimeUiGraph();
  const holder = useRef<{ graph: unknown; generation: number; selector: ReturnType<typeof createHierarchyStructureSelector>; mounted: ReturnType<ReturnType<typeof createHierarchyStructureSelector>['mount']> } | null>(null);
  const generation = graph?.stats().worldGeneration ?? 0;
  if (graph && (holder.current?.graph !== graph || holder.current.generation !== generation)) {
    const selector = createHierarchyStructureSelector(graph);
    holder.current = { graph, generation, selector, mounted: selector.mount() };
  }
  const binding = holder.current;
  const getSnapshot = useCallback(() => binding?.mounted.getSnapshot(), [binding]);
  const subscribe = useCallback((listener: () => void) => binding?.mounted.subscribe(listener) ?? (() => undefined), [binding]);
  useEffect(() => () => binding?.mounted.unsubscribe(), [binding]);
  const localProjection = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // A shell may retain a bootstrap/dummy World for legacy chrome wiring. Its
  // mere presence does not make it authoritative once a Runtime carrier is
  // connected: the carrier projection wins, and the local graph is only the
  // in-process fallback used when no remote projection exists.
  return remoteProjection !== undefined
    ? { structure: remoteProjection.structure, remote: remoteProjection }
    : { structure: localProjection, remote: undefined };
}

function projectionRow(projection: HierarchyStructureProjection | undefined, id: EntityHandle): HierarchyRowVM | undefined {
  if (!projection) return undefined;
  const row = projection?.rows.find((candidate) => candidate.id === id);
  if (!row) return undefined;
  const cache = projectionVmCache.get(projection) ?? new Map<EntityHandle, HierarchyRowVM>();
  projectionVmCache.set(projection, cache);
  const previous = cache.get(id);
  if (previous) return previous;
  const value = {
    exists: true,
    name: row.name,
    typeId: row.typeId,
    hidden: row.hidden ?? false,
    ancestorHidden: row.ancestorHidden ?? false,
    mobilityKey: row.mobility,
    childIds: row.childIds,
  };
  cache.set(id, value);
  return value;
}

const Row = memo(function Row({
  id,
  depth,
  onMenu,
  flat,
  virtualized,
  toggleCollapse,
  highlight,
  readOnly,
  columns,
  projection,
}: {
  id: EntityHandle;
  depth: number;
  onMenu: (m: Menu) => void;
  flat?: boolean | undefined;
  virtualized?: boolean | undefined;
  toggleCollapse?: ((id: EntityHandle) => void) | undefined;
  highlight?: string | undefined;
  readOnly?: boolean | undefined;
  columns: HierarchyColumns;
  projection?: HierarchyStructureProjection | undefined;
}) {
  const { t } = useTranslation();
  const remote = useContext(RemoteHierarchyContext);
  // Per-row subscriptions: each source (structural VM / selection / hover /
  // collapse) re-renders ONLY the rows whose own value actually flips
  // (useSyncExternalStore bails on Object.is), so a doc churn or a hover move
  // no longer repaints the whole tree.
  const vm = useHierarchyRowVM(id, projection);
  const localIsSelected = useIsSelected(id);
  const isSelected = remote?.selectionIds.has(id) ?? localIsSelected;
  const isHovered = useIsHoverEntity(id);
  const isCollapsed = useIsHierarchyCollapsed(id);
  const [dropPos, setDropPos] = useState<DropPos | null>(null);
  const [editing, setEditing] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  // F2 (or any panel) can request this row to enter inline-rename mode.
  useEffect(() => onRenameRequest((rid) => rid === id && setEditing(true)), [id]);
  useEffect(() => {
    if (isSelected && rowRef.current) {
      rowRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [isSelected]);
  // Cross-game gap: activeWorld may be briefly undefined while old Row fibers
  // still re-render — the snapshot reports exists:false and we bail (AC-01).
  if (!vm.exists) return null;
  const { name: nodeName, typeId, hidden: nodeHidden, ancestorHidden: nodeAncestorHidden, mobilityKey } = vm;
  const children = vm.childIds;
  const kids = flat ? EMPTY_IDS : children;
  const renderedKids = virtualized ? EMPTY_IDS : kids;
  const typeLabel = componentTypeLabel(typeId, t);
  const typeToken = hierarchyTypeToken(typeId);
  const mobilityLabel = mobilityKey ? t(`editor.hierarchy.mobility.${mobilityKey}`) : '';
  const TypeIcon = hierarchyTypeIcon(typeId);
  function commitRename(next: string) {
    setEditing(false);
    const name = next.trim();
    if (name && name !== nodeName) void dispatchActiveEditorOperation({ kind: 'rename', entity: id, name });
  }
  return (
    <>
      <div
        ref={rowRef}
        className={`tn k-${typeToken.toLowerCase()}${isSelected ? ' sel' : ''}${nodeHidden ? ' dim' : nodeAncestorHidden ? ' pdim' : ''}${dropPos === 'inside' ? ' drop' : ''}${dropPos === 'before' ? ' drop-before' : ''}${dropPos === 'after' ? ' drop-after' : ''}${isHovered ? ' hov' : ''}`}
        data-testid={`hier-row-${id}`}
        tabIndex={isSelected ? 0 : -1}
        title={`${nodeName} · #${id}${!nodeHidden && nodeAncestorHidden ? ` · ${t('editor.hierarchy.hiddenByAncestor')}` : ''}`}
        onFocus={() => { focusedHierarchyEntity = id; }}
        onMouseEnter={() => dispatchHierarchyOperation({ kind: 'setHoverEntity', id })}
        onMouseLeave={() => dispatchHierarchyOperation({ kind: 'setHoverEntity', id: null })}
        onClick={(e) => {
          e.currentTarget.focus();
          if (e.shiftKey) {
            handleShiftClick(id, getHierarchyPanelSnapshot().collapsed, remote);
          } else if (e.metaKey || e.ctrlKey) {
            dispatchHierarchyOperation({ kind: 'toggleSelection', id });
            anchorId = id;
          } else {
            dispatchHierarchyOperation({ kind: 'setSelection', id });
            anchorId = id;
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          // keep an existing multi-selection if right-clicking inside it
          const selection = remote?.selectionIds ?? getSelectionList();
          if (!selection.has(id)) dispatchHierarchyOperation({ kind: 'setSelection', id });
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
          const dragging = draggedIds(remote);
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
          if (draggingId !== null && !readOnly) applyDrop(id, pos, remote);
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
            // Same-state selected siblings follow the click as ONE transaction
            // (one undo step) via the shared core op (north-star §3.2).
            const sel = remote?.selectionIds ?? getSelectionList();
            const ids = sel.has(id)
              ? [id, ...[...sel].filter((sid) => sid !== id && (
                remote === null
                  ? (readVisibilityIntent(gateway.activeWorld, sid) === 'hidden') === nodeHidden
                  : (remote.structure.rows.find((row) => row.id === sid)?.hidden ?? false) === nodeHidden
              ))]
              : [id];
            void dispatchActiveEditorOperation({
              kind: 'hierarchyGesture',
              action: 'visibility',
              entities: ids,
              state: newHidden ? 'hidden' : 'visible',
            });
          }}
        >
          {nodeHidden ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
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
            {typeId === HIERARCHY_GROUP_TYPE_ID ? <span className="kind">{typeLabel}</span> : typeLabel}
          </span>
        )}
        {columns.mobility && <span className={`cell mob col-mob mob-${mobilityKey || 'none'}`}>{mobilityLabel}</span>}
        {columns.id && <span className="cell id col-id" title={`Entity #${id}`}>{id}</span>}
      </div>
      {!isCollapsed &&
        renderedKids.map((k) => (
          <Row key={k} id={k} depth={depth + 1} onMenu={onMenu} toggleCollapse={toggleCollapse} readOnly={readOnly} columns={columns} projection={projection} />
        ))}
    </>
  );
});

// Dropping onto the virtual "Scene" root folder (SceneFolderRow) is the single
// "move to root" path now — it reparents the dragged node(s) to null exactly
// like the old top-of-tree RootDropBar did, so no separate always-present bar
// (and its empty band at the top of the panel) is needed.

const SceneFolderRow = memo(function SceneFolderRow({
  childrenIds,
  visibilityIds,
  filtered,
  renderChildren = true,
  highlight,
  onMenu,
  onBlankMenu,
  toggleCollapse,
  readOnly,
  columns,
  projection,
}: {
  childrenIds: readonly EntityHandle[];
  visibilityIds?: readonly EntityHandle[] | undefined;
  filtered?: boolean | undefined;
  renderChildren?: boolean | undefined;
  highlight?: string | undefined;
  onMenu: (m: Menu) => void;
  onBlankMenu: (x: number, y: number) => void;
  toggleCollapse: (id: EntityHandle) => void;
  readOnly: boolean;
  columns: HierarchyColumns;
  projection?: HierarchyStructureProjection | undefined;
}) {
  const { t } = useTranslation();
  const remote = useContext(RemoteHierarchyContext);
  const [dropPos, setDropPos] = useState<DropPos | null>(null);
  const sceneCollapsed = useIsHierarchyCollapsed(HIERARCHY_SCENE_FOLDER_ID);
  const isCollapsed = !filtered && sceneCollapsed;
  const sceneLabel = t('editor.hierarchy.sceneRoot');
  const folderTypeLabel = t('editor.hierarchy.types.folder');
  const visibilityTargets = collectEntitySubtree(visibilityIds ?? childrenIds, remote?.structure);
  const folderHidden = visibilityTargets.length > 0
    && visibilityTargets.every((id) => remote === null
      ? readVisibilityIntent(gateway.activeWorld, id) === 'hidden'
      : remote.structure.rows.find((row) => row.id === id)?.hidden === true);
  const setFolderHidden = (hidden: boolean) => {
    if (readOnly) return;
    void dispatchActiveEditorOperation({
      kind: 'hierarchyGesture',
      action: 'visibility',
      entities: visibilityTargets,
      state: hidden ? 'hidden' : 'visible',
    });
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
            const ids = draggedIds(remote);
            moveRootDisplayOrder(ids, null, 'end');
            void dispatchActiveEditorOperation({ kind: 'hierarchyGesture', action: 'reparent', entities: ids, parent: null });
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
      {!isCollapsed && renderChildren && childrenIds.map((id) => (
        <Row
          key={id}
          id={id}
          depth={1}
          onMenu={onMenu}
          flat={filtered}
          toggleCollapse={toggleCollapse}
          highlight={highlight}
          readOnly={readOnly}
          columns={columns}
          projection={projection}
        />
      ))}
    </>
  );
});

const HIERARCHY_ROW_HEIGHT = 25;

function VirtualizedRows({
  rows,
  scrollRef,
  flat,
  highlight,
  onMenu,
  toggleCollapse,
  readOnly,
  columns,
  projection,
}: {
  rows: readonly HierarchyVisibleRow[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  flat?: boolean | undefined;
  highlight?: string | undefined;
  onMenu: (m: Menu) => void;
  toggleCollapse: (id: EntityHandle) => void;
  readOnly: boolean;
  columns: HierarchyColumns;
  projection?: HierarchyStructureProjection | undefined;
}) {
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => HIERARCHY_ROW_HEIGHT,
    overscan: 12,
  });
  const remote = useContext(RemoteHierarchyContext);
  const localSelectedId = useSelection();
  const selectedId = remote?.primarySelection ?? localSelectedId;
  const selectedIndex = selectedId === null ? -1 : rows.findIndex((row) => row.id === selectedId);
  useEffect(() => {
    if (selectedIndex >= 0) rowVirtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
  }, [rowVirtualizer, selectedIndex]);
  return (
    <div
      data-testid="hierarchy-virtual-rows"
      style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}
    >
      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index]!;
        return (
          <div
            key={virtualRow.key}
            ref={rowVirtualizer.measureElement}
            data-index={virtualRow.index}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <Row
              id={row.id}
              depth={row.depth}
              onMenu={onMenu}
              flat={flat}
              virtualized
              toggleCollapse={toggleCollapse}
              highlight={highlight}
              readOnly={readOnly}
              columns={columns}
              projection={projection}
            />
          </div>
        );
      })}
    </div>
  );
}

export function HierarchyPanel() {
  const { t } = useTranslation();
  // The runtime graph is created by the viewport host during boot. A panel can
  // render before that happens, so subscribe to the authored boot/load signal
  // as well; otherwise the first `graph === null` snapshot is never replaced
  // and the hierarchy remains an empty folder until another unrelated render.
  useDocVersion();
  const { structure: projection, remote: remoteProjectionState } = useHierarchyProjection();
  const remoteContext = useMemo<RemoteHierarchyContextValue | null>(() => {
    if (remoteProjectionState === undefined) return null;
    const selectionIds = new Set(remoteProjectionState.selectionIds);
    return {
      selectionIds,
      primarySelection: remoteProjectionState.selectionIds.at(-1) ?? null,
      structure: remoteProjectionState.structure,
    };
  }, [remoteProjectionState]);
  const view = useSyncExternalStore(
    subscribeHierarchyPanelState,
    getHierarchyPanelSnapshot,
    getHierarchyPanelSnapshot,
  );
  // Play mode makes the active world a read-only simulation view: document ops
  // are rejected at the gateway (`edit-rejected-in-play`). Disable the editing
  // controls so they don't silently no-op (P0-4). enterPlay/exitPlay emit, so
  // useDocVersion re-renders this on mode change.
  useEffect(() => {
    return onSelectionChange(() => {
      const sel = getSelection();
      if (sel !== null) revealHierarchyEntity(sel);
    });
  }, []);

  // Auto-expand the virtual "Scene" root whenever the active scene identity
  // changes (initial boot, or a switch between scene files). A scene load clears
  // the selection (replaceDoc), so revealHierarchyEntity — the only other path
  // that opens the root — never fires here; without this the freshly loaded tree
  // would stay hidden behind a persisted collapse of the root. Keyed on the scene
  // id (not docVersion, which also bumps every Play-mode frame) so it fires once
  // per real load, and expandHierarchySceneFolder is a no-op when already open.
  const sceneModel = useSceneReadModel();
  const activeSceneId = sceneModel.currentScene?.id
    ?? sceneModel.scenes.find((entry) => entry.isCurrent)?.id
    ?? null;
  useEffect(() => {
    if (activeSceneId === null) return;
    expandHierarchySceneFolder();
  }, [activeSceneId]);

  const activeWorld = gateway.activeWorld;
  const remoteProjection = remoteContext !== null;
  const readOnly = remoteProjectionState?.mode === 'play' || (!remoteProjection && gateway.mode === 'play');
  const worldReady = activeWorld != null || projection !== undefined;
  const hierarchyBodyRef = useRef<HTMLDivElement>(null);
  const hierarchyRootRef = useRef<HTMLDivElement>(null);
  useKeybindingScope(hierarchyRootRef, 'editor.hierarchy');
  const worldEntityIds = remoteProjection
    ? projection?.rows.map((row) => row.id) ?? EMPTY_IDS
    : activeWorld ? worldEntityHandles(activeWorld) : EMPTY_IDS;
  // The runtime projection is the cheap structural read model, but a freshly
  // dispatched public transaction can land before its runtime graph publish.
  // Never let that transient lag hide authored entities: when its cardinality
  // disagrees with the active world, use the same world's value-stable row VM
  // until the projection catches up.
  const usableProjection = remoteProjection
    ? projection
    : projection && projection.rows.length === worldEntityIds.length ? projection : undefined;
  if (worldReady) pruneDisplayOrder(worldEntityIds);
  // Root order derives from the doc. `docVersion` is referenced so the panel
  // re-derives roots when the document mutates (incl. the per-frame Play mirror),
  // but useStableIds collapses value-equal results to the SAME array reference,
  // so the SceneFolderRow memo (and therefore the rows) stay put across a 60fps
  // churn. Each Row otherwise self-subscribes to its own structural snapshot —
  // no whole-tree component index is threaded down anymore.
  const projectedChildIds = usableProjection
    ? new Set(usableProjection.rows.flatMap((row) => row.childIds))
    : undefined;
  const projectedRoots = usableProjection
    ? usableProjection.rows.filter((row) => !projectedChildIds!.has(row.id)).map((row) => row.id)
    : !remoteProjection && activeWorld ? childrenOf(activeWorld, null) : EMPTY_IDS;
  const roots = useStableIds(worldReady ? stableDisplayOrder(projectedRoots) : EMPTY_IDS);
  const visibleRows = useMemo(() => {
    if ((!activeWorld && !usableProjection) || view.collapsed.has(HIERARCHY_SCENE_FOLDER_ID)) return [];
    return flattenVisibleRows(roots, view.collapsed, activeWorld, usableProjection);
  }, [activeWorld, roots, usableProjection, view.collapsed]);
  useEffect(() => {
    console.info(`[placement-diag] hierarchy.snapshot ${JSON.stringify({
      gatewayRev: gateway.rev,
      mode: gateway.mode,
      worldReady,
      projectionRows: usableProjection?.rows.length ?? null,
      visibleRoots: roots,
      worldEntityCount: worldEntityIds.length,
    })}`);
  }, [activeWorld, roots, usableProjection?.rows.length, worldEntityIds.length, worldReady]);
  const toggleCollapse = useCallback((id: EntityHandle) => toggleHierarchyCollapsed(id), []);
  const spawnEntity = () => {
    if (readOnly) return;
    void dispatchActiveEditorOperation({
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
    void dispatchActiveEditorOperation({
      kind: 'spawnEntity',
      name: preset.label,
      parent: getSelection(),
      components: buildPresetComponents(preset),
    });
  };
  const selectedEntities = (): EntityHandle[] => remoteContext === null
    ? [...getSelectionList()]
    : [...remoteContext.selectionIds];
  const hierarchyGesture = (
    action: Extract<HierarchyOperation, { kind: 'hierarchyGesture' }>['action'],
    entities: readonly EntityHandle[],
    extra: Pick<Extract<HierarchyOperation, { kind: 'hierarchyGesture' }>, 'parent' | 'state'> = {},
  ) => dispatchActiveEditorOperation({ kind: 'hierarchyGesture', action, entities: [...entities], ...extra });
  const selectAll = () => {
    const ids = remoteContext
      ? remoteContext.structure.rows.map((row) => row.id)
      : gateway.activeWorld ? worldEntityHandles(gateway.activeWorld) : EMPTY_IDS;
    dispatchHierarchyOperation({ kind: 'setSelectionMany', ids: [...ids] });
  };
  const showAll = () => {
    if (readOnly) return;
    const hidden = remoteContext === null
      ? worldEntityHandles(gateway.activeWorld).filter((id) => readVisibilityIntent(gateway.activeWorld, id) === 'hidden')
      : remoteContext.structure.rows.filter((row) => row.hidden).map((row) => row.id);
    if (hidden.length > 0) void hierarchyGesture('visibility', hidden, { state: 'visible' });
  };
  const clearViewFilters = () => {
    clearHierarchySearchQuery();
    clearHierarchyFilters();
  };
  const focusSelectionInViewport = () => {
    const selected = remoteContext?.primarySelection ?? getSelection();
    if (selected !== null) void dispatchActiveEditorOperation({ kind: 'requestFrame' });
  };
  const createMenuItems = (): MenuItemDef[] => [
    { label: t('editor.hierarchy.menu.createEntity'), icon: 'file-plus', onClick: spawnEntity, disabled: readOnly },
    ...ENTITY_PRESETS.map((preset) => ({
      label: t(`editor.hierarchy.menu.presets.${preset.label}`, { defaultValue: preset.label }),
      icon: 'box',
      onClick: () => spawnPreset(preset.label),
      disabled: readOnly,
    })),
    { label: t('editor.hierarchy.menu.newFolder'), icon: 'folder-plus', disabled: true },
    {
      label: t('editor.hierarchy.menu.newGroup'),
      icon: 'layers',
      onClick: () => { void hierarchyGesture('group', selectedEntities()); },
      disabled: readOnly || selectedEntities().length < 2,
    },
  ];
  // Build the right-click menu items and hand them to the shared service, which
  // renders at the top layer of the whole window (or posts to the interface
  // parent when embedded in an iframe) — never clipped by this panel's bounds.
  const openMenu = useEvent((m: Menu) => {
    if (!activeWorld && remoteContext === null) return;
    const snapshot = selectedEntities();
    const multi = snapshot.length > 1;
    const projectedRow = remoteContext?.structure.rows.find((row) => row.id === m.id);
    const items: MenuItemDef[] = [];
    items.push({ label: t('editor.hierarchy.menu.create'), icon: 'folder-plus', children: createMenuItems() });
    items.push({ sep: true });
    if (multi) {
      items.push({ label: t('editor.hierarchy.menu.group', { n: snapshot.length }), icon: 'layers', onClick: () => { void hierarchyGesture('group', snapshot); } });
      items.push({ label: t('editor.hierarchy.menu.deleteSelected', { n: snapshot.length }), icon: 'trash-2', onClick: () => { void hierarchyGesture('delete', snapshot); } });
      items.push({ sep: true });
    }
    items.push({ label: t('editor.hierarchy.menu.rename'), icon: 'pencil', shortcut: 'F2', onClick: () => { void dispatchActiveEditorOperation({ kind: 'requestRename', entity: m.id }); }, disabled: readOnly });
    items.push({ label: t('editor.hierarchy.menu.duplicate'), icon: 'copy', shortcut: 'Ctrl+D', onClick: () => { void hierarchyGesture('duplicate', [m.id]); } });
    items.push({ label: t('editor.hierarchy.menu.copyJson'), icon: 'braces', onClick: () => {
      const value = projectedRow ?? (entExists(gateway.activeWorld, m.id)
        ? { id: m.id, name: entName(gateway.activeWorld, m.id), components: entComponents(gateway.activeWorld, m.id) }
        : null);
      if (value !== null) void navigator.clipboard?.writeText(JSON.stringify(value, null, 2));
    } });
    items.push({ label: t('editor.hierarchy.menu.refToChat'), icon: 'spark', forge: true, shortcut: 'Ctrl+K', onClick: () => requestRefEntity(m.id) });
    const childIds = projectedRow?.childIds ?? childrenOf(gateway.activeWorld, m.id);
    if (childIds.length > 0) items.push({ label: t('editor.hierarchy.menu.ungroup'), icon: 'layers', onClick: () => { void hierarchyGesture('ungroup', [m.id]); } });
    const hidden = projectedRow?.hidden ?? (readVisibilityIntent(gateway.activeWorld, m.id) === 'hidden');
    items.push({ sep: true });
    items.push({ label: hidden ? t('editor.hierarchy.menu.show') : t('editor.hierarchy.menu.hide'), icon: 'eye', shortcut: 'H', onClick: () => { void hierarchyGesture('visibility', [m.id], { state: hidden ? 'visible' : 'hidden' }); }, disabled: readOnly });
    items.push({ label: t('editor.hierarchy.menu.focusViewport'), icon: 'crosshair', shortcut: 'F', onClick: focusSelectionInViewport });
    items.push({ label: t('editor.hierarchy.menu.moveTo'), icon: 'folder', disabled: true });
    items.push({ sep: true });
    items.push({ label: t('editor.hierarchy.menu.delete'), icon: 'trash-2', shortcut: 'Del', danger: true, onClick: () => { void hierarchyGesture('delete', multi ? snapshot : [m.id]); } });
    showContextMenu({ clientX: m.x, clientY: m.y, preventDefault: () => {} }, items);
  });
  const openBlankMenu = useEvent((x: number, y: number) => {
    const items: MenuItemDef[] = [
      { label: t('editor.hierarchy.menu.create'), icon: 'folder-plus', children: createMenuItems() },
      { sep: true },
      { label: t('editor.hierarchy.menu.paste'), icon: 'copy', shortcut: 'Ctrl+V', disabled: true },
      { label: t('editor.hierarchy.menu.selectAll'), icon: 'box-select', shortcut: 'Ctrl+A', onClick: selectAll },
      { label: t('editor.hierarchy.menu.deselect'), icon: 'crosshair', onClick: () => dispatchHierarchyOperation({ kind: 'setSelection', id: null }) },
      { sep: true },
      { label: t('editor.hierarchy.menu.expandAll'), icon: 'chevrons-up-down', onClick: expandHierarchyAll },
      { label: t('editor.hierarchy.menu.collapseAll'), icon: 'chevrons-down-up', onClick: collapseHierarchyAll },
      { label: t('editor.hierarchy.menu.clearSearchFilters'), icon: 'folder-search', onClick: clearViewFilters, disabled: !hasHierarchyViewFilter() },
      { sep: true },
      { label: t('editor.hierarchy.menu.showAll'), icon: 'eye', shortcut: 'Ctrl+H', onClick: showAll, disabled: readOnly },
      { label: t('editor.hierarchy.menu.focusSelection'), icon: 'crosshair', shortcut: 'F', onClick: focusSelectionInViewport, disabled: getSelection() === null },
      { label: t('editor.hierarchy.menu.refreshOutliner'), icon: 'refresh-cw', disabled: true },
    ];
    showContextMenu({ clientX: x, clientY: y, preventDefault: () => {} }, items);
  });
  // When filtering, flatten to all entities whose NAME or any COMPONENT name
  // matches (tree semantics dropped so deep matches surface immediately). Matching
  // by component lets a human/AI find entities by capability, e.g. "light".
  // M7 / AC-15: entity list + name/components come from world (SSOT) via
  // entity-state; doc.order/doc.entities deleted.
  const filtering = hasHierarchyViewFilter();
  const matches = useMemo(
    () => filtering && worldReady ? stableDisplayOrder(getHierarchyVisibleMatches()) : [],
    [filtering, view.filters, view.searchQuery, worldReady, activeWorld],
  );
  useEffect(() => {
    hierarchyCommandActions = createHierarchyCommandActions({
      readOnly,
      getFocusedEntity: () => focusedHierarchyEntity,
      getSelectedEntities: selectedEntities,
      renameEntity: (entity) => {
        void dispatchActiveEditorOperation({ kind: 'requestRename', entity });
      },
      deleteEntities: (entities) => {
        void hierarchyGesture('delete', entities);
      },
      selectAll,
    });
    return () => {
      hierarchyCommandActions = null;
      focusedHierarchyEntity = null;
    };
  });

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
    <RemoteHierarchyContext.Provider value={remoteContext}>
    <div
      ref={hierarchyRootRef}
      className="panel outliner-panel"
      data-testid="panel-hierarchy"
      style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      tabIndex={selectedEntities().length > 0 ? -1 : 0}
      onFocus={(event) => {
        if (event.target === event.currentTarget) focusedHierarchyEntity = null;
      }}
    >
      <div className="ol-colhead" data-testid="hier-colhead">
        <span className="ch-eye" />
        <span className="ch-name sortable">{t('editor.hierarchy.columns.name')}</span>
        {view.columns.type && <span className="ch-type sortable col-type">{t('editor.hierarchy.columns.type')}</span>}
        {view.columns.mobility && <span className="ch-mob sortable col-mob">{t('editor.hierarchy.columns.mobilityShort')}</span>}
        {view.columns.id && <span className="ch-id sortable col-id">{t('editor.hierarchy.columns.id')}</span>}
      </div>
      {filtering ? (
        <div
          className="ol-body"
          data-testid="hier-filtered"
          ref={hierarchyBodyRef}
          style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('.tn')) return;
            dispatchHierarchyOperation({ kind: 'setSelection', id: null });
            clearAssetSelection();
            clearFolderSelection();
          }}
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
              toggleCollapse={toggleCollapse}
              renderChildren={false}
              readOnly={readOnly}
              columns={view.columns}
              projection={usableProjection}
            />
          )}
          {matches.length > 0 && (
            <VirtualizedRows
              rows={matches.map((id) => ({ id, depth: 1 }))}
              scrollRef={hierarchyBodyRef}
              flat
              highlight={view.searchQuery.trim()}
              onMenu={openMenu}
              toggleCollapse={toggleCollapse}
              readOnly={readOnly}
              columns={view.columns}
              projection={usableProjection}
            />
          )}
        </div>
      ) : (
        <div
          className="ol-body"
          data-testid="hier-root-dropzone"
          ref={hierarchyBodyRef}
          style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
          onDragOver={(e) => {
            if (draggingId !== null && !readOnly) e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            // Empty area below the rows = move to root (parent = null).
            if (draggingId !== null && !readOnly) {
              const ids = draggedIds(remoteContext);
              moveRootDisplayOrder(ids, null, 'end');
              void hierarchyGesture('reparent', ids, { parent: null });
            }
            draggingId = null;
          }}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('.tn')) return;
            dispatchHierarchyOperation({ kind: 'setSelection', id: null });
            clearAssetSelection();
            clearFolderSelection();
          }}
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest('.tn')) return;
            openBlankMenu(e.clientX, e.clientY);
          }}
        >
          <SceneFolderRow
            childrenIds={roots}
            visibilityIds={roots}
            onMenu={openMenu}
            onBlankMenu={openBlankMenu}
            toggleCollapse={toggleCollapse}
            renderChildren={false}
            readOnly={readOnly}
            columns={view.columns}
            projection={usableProjection}
          />
          <VirtualizedRows
            rows={visibleRows}
            scrollRef={hierarchyBodyRef}
            onMenu={openMenu}
            toggleCollapse={toggleCollapse}
            readOnly={readOnly}
            columns={view.columns}
            projection={usableProjection}
          />
        </div>
      )}
    </div>
    </RemoteHierarchyContext.Provider>
  );
}
