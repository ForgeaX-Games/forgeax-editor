// skeleton-tree.ts — Build a read-only bone hierarchy from SkinAsset.jointPaths.
//
// A rigged mesh's SkinAsset carries `jointPaths`: Name-component paths from the
// scene root to each joint, separated by `/` (see post-spawn-resolve-joints.ts:
// `jointPath.split('/').filter(Boolean)`). This module parses those flat path
// strings into a nested tree for the Skeleton Tree panel (P1.4) — the read-only
// equivalent of UE's Skeletal Mesh Editor skeleton tree.
//
// Pure string processing: no engine world, no ECS read, no async. The service
// feeds it the union of every SkinAsset's jointPaths for the active Scene
// subject; the panel renders the result. Shared path prefixes (e.g.
// "root/spine" and "root/spine/head") collapse into parent→child nodes, and
// duplicate paths dedupe so a joint referenced by two skins appears once.

export interface SkeletonTreeNode {
  /** Leaf name (last segment of the joint path). */
  readonly name: string;
  /** Full joint path (`/`-separated), the SkinAsset.jointPaths entry. */
  readonly path: string;
  /** Children, ordered by first appearance in the input path list. */
  readonly children: readonly SkeletonTreeNode[];
}

/**
 * Parse a flat list of `/`-separated joint paths into a nested tree.
 *
 * Returns the empty array when `jointPaths` is empty. Path segments are
 * trimmed of empty splits (a leading/trailing `/` or `//` collapses), matching
 * the engine's `split('/').filter(Boolean)` resolution semantics so the tree
 * never invents nodes the engine would not resolve.
 */
export function buildSkeletonTree(jointPaths: readonly string[]): SkeletonTreeNode[] {
  const roots: WorkingNode[] = [];
  // Mutable working shape; frozen into SkeletonTreeNode on the way out.
  interface WorkingNode { name: string; path: string; children: WorkingNode[] }
  const indexByPath = new Map<string, WorkingNode>();

  for (const jointPath of jointPaths) {
    const segments = jointPath.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    let parentChildren = roots;
    let cumulative = '';
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i] as string;
      cumulative = cumulative.length === 0 ? segment : `${cumulative}/${segment}`;
      const isLeaf = i === segments.length - 1;

      let node = indexByPath.get(cumulative);
      if (node === undefined) {
        node = { name: segment, path: cumulative, children: [] };
        indexByPath.set(cumulative, node);
        parentChildren.push(node);
      }
      // A path may end at a node that was previously only an interior prefix
      // (e.g. "root/spine" appears after "root/spine/head"). The node already
      // exists from the longer path; nothing to add — its `path` already
      // records the cumulative string and its children stay intact.
      parentChildren = node.children;
      void isLeaf;
    }
  }

  const freeze = (node: WorkingNode): SkeletonTreeNode => ({
    name: node.name,
    path: node.path,
    children: node.children.map(freeze),
  });
  return roots.map(freeze);
}
