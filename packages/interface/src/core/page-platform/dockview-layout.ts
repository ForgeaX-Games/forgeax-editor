import type { PageLayoutEnvelope, PageLayoutNode } from '@forgeax/types';
import type { SerializedDockview } from 'dockview';
import type { PagePanelPlacement } from './types';

type DockGridNode =
  | {
      readonly type: 'branch';
      readonly size: number;
      readonly data: readonly DockGridNode[];
    }
  | {
      readonly type: 'leaf';
      readonly size: number;
      readonly data: {
        readonly views: readonly string[];
        readonly activeView?: string;
        readonly id: string;
      };
    };

interface CompileContext {
  readonly pageId: string;
  readonly groupIds: string[];
}

function childSizes(node: Extract<PageLayoutNode, { kind: 'split' }>): readonly number[] {
  if (node.sizes?.length === node.children.length) return node.sizes;
  return node.children.map(() => 1);
}

function compileNode(
  node: PageLayoutNode,
  size: number,
  path: readonly number[],
  context: CompileContext,
): DockGridNode {
  if (node.kind === 'tabs') {
    const suffix = path.length > 0 ? path.join('-') : 'root';
    const id = `page-${context.pageId}-${suffix}`;
    context.groupIds.push(id);
    return {
      type: 'leaf',
      size,
      data: {
        views: node.placements,
        ...(node.active ? { activeView: node.active } : {}),
        id,
      },
    };
  }

  const sizes = childSizes(node);
  return {
    type: 'branch',
    size,
    data: node.children.map((child, index) =>
      compileNode(child, sizes[index]!, [...path, index], context),
    ),
  };
}

function rootChildren(layout: PageLayoutEnvelope, context: CompileContext): readonly DockGridNode[] {
  if (layout.root.kind === 'tabs') {
    return [compileNode(layout.root, 1, [], context)];
  }
  const sizes = childSizes(layout.root);
  return layout.root.children.map((child, index) =>
    compileNode(child, sizes[index]!, [index], context),
  );
}

/** Compile Page-owned semantic panel positions into Dockview's transport.
 * The Page is the SSOT: pane names and panel implementation details never
 * participate in layout decisions. */
export function pageLayoutToDockview(
  pageId: string,
  pageTitle: string,
  placements: readonly PagePanelPlacement[],
  layout: PageLayoutEnvelope,
): SerializedDockview {
  const safePageId = pageId.replace(/[^a-z0-9.-]+/giu, '-').replace(/^-+|-+$/gu, '') || 'page';
  const context: CompileContext = { pageId: safePageId, groupIds: [] };
  const root = layout.root;
  const rootSizes = root.kind === 'split' ? childSizes(root) : [1];
  const total = rootSizes.reduce((sum, size) => sum + size, 0);
  const horizontal = root.kind !== 'split' || root.direction === 'horizontal';

  return {
    grid: {
      height: horizontal ? 800 : Math.max(800, total),
      width: horizontal ? Math.max(1200, total) : 1200,
      orientation: horizontal ? 'HORIZONTAL' : 'VERTICAL',
      root: {
        type: 'branch',
        size: horizontal ? 800 : 1200,
        data: rootChildren(layout, context),
      },
    },
    panels: Object.fromEntries(placements.map((placement) => [placement.id, {
      id: placement.id,
      contentComponent: placement.id,
      title: placement.title ?? (placements.length === 1 ? pageTitle : placement.id),
    }])),
    activeGroup: context.groupIds.at(-1),
  } as SerializedDockview;
}
