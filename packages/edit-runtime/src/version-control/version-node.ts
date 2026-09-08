import type { VersionControlGraph } from '@forgeax/editor-core';

export type VersionControlGraphNode = VersionControlGraph['nodes'][number];
export type VersionControlGraphEdge = VersionControlGraph['edges'][number];

export interface VersionControlTreeRow {
  readonly node: VersionControlGraphNode;
  /** Bounded visual branch depth; linear history stays on the main lane. */
  readonly depth: number;
  /** Visible ancestors, normalized to graph node ids for inline base labels. */
  readonly parentIds: readonly string[];
}

export interface VersionControlTreeEdge {
  readonly from: string;
  readonly to: string;
  readonly fromIndex: number;
  readonly toIndex: number;
}

export interface VersionControlTargetOption {
  readonly value: string;
  readonly commit: string;
  readonly shortHash: string;
  readonly current: boolean;
  readonly label: string;
}

export function versionNodeTags(node: VersionControlGraphNode): readonly string[] {
  return node.tags?.length ? node.tags : (node.tag ? [node.tag] : []);
}

function versionNodeTime(node: VersionControlGraphNode): number {
  return typeof node.committedAt === 'number' && Number.isFinite(node.committedAt)
    ? node.committedAt
    : 0;
}

/** Stable newest-first order shared by the graph and the switch selector. */
export function sortVersionNodes(nodes: readonly VersionControlGraphNode[]): VersionControlGraphNode[] {
  return [...nodes].sort((left, right) => {
    const timeOrder = versionNodeTime(right) - versionNodeTime(left);
    if (timeOrder !== 0) return timeOrder;
    if (left.latest !== right.latest) return left.latest ? -1 : 1;
    return right.head.localeCompare(left.head);
  });
}

const MAX_VERSION_TREE_DEPTH = 3;

/**
 * Project the commit DAG into a readable tree lane for the compact status-bar
 * popover. Edges point from a child commit to its visible ancestor. A linear
 * chain remains on one lane; only sibling branches add indentation. The depth
 * cap prevents a long history from growing beyond the panel's usable width.
 */
export function versionNodeTreeRows(
  nodes: readonly VersionControlGraphNode[],
  edges: readonly VersionControlGraphEdge[],
): VersionControlTreeRow[] {
  const sorted = sortVersionNodes(nodes);
  if (sorted.length === 0) return [];

  const order = new Map(sorted.map((node, index) => [node.id, index]));
  const byReference = new Map<string, string>();
  for (const node of sorted) {
    byReference.set(node.id, node.id);
    byReference.set(node.head, node.id);
  }

  const parentsByChild = new Map<string, Set<string>>();
  const childrenByParent = new Map<string, string[]>();
  for (const edge of edges) {
    const child = byReference.get(edge.from);
    const parent = byReference.get(edge.to);
    if (child === undefined || parent === undefined || child === parent) continue;
    const parents = parentsByChild.get(child) ?? new Set<string>();
    parents.add(parent);
    parentsByChild.set(child, parents);
    const children = childrenByParent.get(parent) ?? [];
    if (!children.includes(child)) children.push(child);
    childrenByParent.set(parent, children);
  }

  const depthByNode = new Map<string, number>();
  const visit = (parent: string, depth: number, path: Set<string>): void => {
    if (path.has(parent)) return;
    path.add(parent);
    const children = [...(childrenByParent.get(parent) ?? [])].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
    children.forEach((child, index) => {
      const candidate = Math.min(MAX_VERSION_TREE_DEPTH, depth + (index === 0 ? 0 : 1));
      const previous = depthByNode.get(child);
      if (previous !== undefined && previous <= candidate) return;
      depthByNode.set(child, candidate);
      visit(child, candidate, path);
    });
    path.delete(parent);
  };

  // Walk from the oldest visible commits towards newer children. This keeps a
  // normal linear history on one vertical spine while branch siblings move to
  // a bounded secondary lane.
  const roots = sorted.filter((node) => !(parentsByChild.get(node.id)?.size));
  for (const root of roots) {
    if (!depthByNode.has(root.id)) depthByNode.set(root.id, 0);
    visit(root.id, depthByNode.get(root.id) ?? 0, new Set());
  }
  // Be defensive about malformed/cyclic legacy projections: every visible
  // node still receives a bounded lane instead of disappearing from the UI.
  for (const node of sorted) {
    if (depthByNode.has(node.id)) continue;
    depthByNode.set(node.id, 0);
    visit(node.id, 0, new Set());
  }

  return sorted.map((node) => ({
    node,
    depth: depthByNode.get(node.id) ?? 0,
    parentIds: [...(parentsByChild.get(node.id) ?? [])].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0)),
  }));
}

/** Resolve visible ancestry edges to row indexes for the SVG tree renderer. */
export function versionNodeTreeEdges(
  rows: readonly VersionControlTreeRow[],
  edges: readonly VersionControlGraphEdge[],
): VersionControlTreeEdge[] {
  const indexByReference = new Map<string, number>();
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    indexByReference.set(row.node.id, index);
    indexByReference.set(row.node.head, index);
  });
  return edges.flatMap((edge) => {
    const fromIndex = indexByReference.get(edge.from);
    const toIndex = indexByReference.get(edge.to);
    if (fromIndex === undefined || toIndex === undefined || fromIndex === toIndex) return [];
    const key = `${fromIndex}->${toIndex}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ from: rows[fromIndex]!.node.id, to: rows[toIndex]!.node.id, fromIndex, toIndex }];
  });
}

export function isCurrentVersionNode(
  node: VersionControlGraphNode,
  currentTag: string | null | undefined,
  currentHead: string | null | undefined,
): boolean {
  return (
    (currentTag !== null && currentTag !== undefined && versionNodeTags(node).includes(currentTag))
    || (currentHead !== null && currentHead !== undefined && node.head === currentHead)
  );
}

/**
 * Project the switch selector from the same newest-first graph order as the
 * history view. Labels carry current-state context because native options do
 * not reliably expose custom styling across browsers.
 */
export function versionNodeTargetOptions(
  nodes: readonly VersionControlGraphNode[],
  currentTag: string | null | undefined,
  currentHead: string | null | undefined,
): VersionControlTargetOption[] {
  return sortVersionNodes(nodes).flatMap((node) => {
    const tags = versionNodeTags(node);
    const shortHash = node.head.slice(0, 8);
    if (tags.length > 0) {
      return tags.map((tag) => {
        const current = currentTag !== null && currentTag !== undefined
          ? tag === currentTag
          : currentHead !== null && currentHead !== undefined && node.head === currentHead;
        return {
          value: tag,
          commit: node.id,
          shortHash,
          current,
          label: `${tag}${current ? ' (current)' : ''} (${shortHash})`,
        };
      });
    }
    if (!node.latest) return [];
    const current = (currentTag === null || currentTag === undefined)
      && currentHead !== null
      && currentHead !== undefined
      && node.head === currentHead;
    return [{
      value: '@latest',
      commit: node.id,
      shortHash,
      current,
      label: `Latest untagged commit${current ? ' (current)' : ''} (${shortHash})`,
    }];
  });
}

/** Pick the current target when opening the switch dialog, then newest tagged/latest fallback. */
export function initialVersionTarget(
  nodes: readonly VersionControlGraphNode[],
  currentTag: string | null | undefined,
  currentHead: string | null | undefined,
): { readonly tag: string; readonly commit: string } {
  const sorted = sortVersionNodes(nodes);
  const currentNode = sorted.find((node) => isCurrentVersionNode(node, currentTag, currentHead));
  const first = currentNode ?? sorted.find((node) => versionNodeTags(node).length > 0 || node.latest);
  const tags = first === undefined ? [] : versionNodeTags(first);
  const tag = currentNode !== undefined && currentTag !== null && currentTag !== undefined && tags.includes(currentTag)
    ? currentTag
    : (tags[0] ?? (first?.latest ? '@latest' : ''));
  return { tag, commit: first?.id ?? first?.head ?? '' };
}
