import type { VersionControlGraph } from '@forgeax/editor-core';
import { useEffect, useState, type CSSProperties } from 'react';
import { isCurrentVersionNode, versionNodeTags, versionNodeTreeEdges, versionNodeTreeRows, type VersionControlGraphNode } from './version-node';

const GRAPH_ROW_HEIGHT = 38;
const GRAPH_LANE_STEP = 18;
const GRAPH_LANE_PADDING = 8;

function versionNodeLabel(node: VersionControlGraphNode): string {
  return versionNodeTags(node)[0] ?? (node.latest ? 'Latest' : node.head.slice(0, 8));
}

async function copyCommitHash(value: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the legacy DOM copy path when clipboard permissions are
    // unavailable in an embedded or non-secure browser context.
  }
  if (typeof document === 'undefined' || document.body === null) return false;
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', 'true');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { input.remove(); }
}

function CopyCommitHash({ head }: { readonly head: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  return (
    <button
      type="button"
      className="fx-version-graph-hash"
      title={copied ? 'Copied full commit hash' : 'Copy full commit hash'}
      aria-label={`Copy full commit hash ${head}`}
      onClick={() => {
        void copyCommitHash(head).then((success) => {
          setCopied(success);
        });
      }}
    >
      {head.slice(0, 8)}
    </button>
  );
}

export function VersionControlGraphView({
  graph,
  currentTag,
  currentHead,
}: {
  readonly graph: VersionControlGraph;
  readonly currentTag?: string | null;
  readonly currentHead?: string | null;
}) {
  const rows = versionNodeTreeRows(graph.nodes, graph.edges);
  const treeEdges = versionNodeTreeEdges(rows, graph.edges);
  const nodeById = new Map(rows.map((row) => [row.node.id, row.node]));
  const maxDepth = rows.reduce((maximum, row) => Math.max(maximum, row.depth), 0);
  const laneWidth = GRAPH_LANE_PADDING + (maxDepth + 1) * GRAPH_LANE_STEP;
  const graphHeight = rows.length * GRAPH_ROW_HEIGHT;
  const graphStyle = {
    '--fx-version-lane-width': `${laneWidth}px`,
    '--fx-version-graph-height': `${graphHeight}px`,
    '--fx-version-row-height': `${GRAPH_ROW_HEIGHT}px`,
  } as CSSProperties;
  return (
    <div className="fx-version-graph" role="tree" aria-label="Version graph" style={graphStyle}>
      {rows.length === 0 ? <div className="fx-empty">No version history</div> : null}
      {rows.length > 0 ? (
        <svg
          className="fx-version-graph-svg"
          viewBox={`0 0 ${laneWidth} ${graphHeight}`}
          role="presentation"
          aria-hidden="true"
        >
          {treeEdges.map((edge) => {
            const fromDepth = rows[edge.fromIndex]!.depth;
            const toDepth = rows[edge.toIndex]!.depth;
            const fromX = GRAPH_LANE_PADDING / 2 + fromDepth * GRAPH_LANE_STEP;
            const toX = GRAPH_LANE_PADDING / 2 + toDepth * GRAPH_LANE_STEP;
            const fromY = edge.fromIndex * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2;
            const toY = edge.toIndex * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2;
            const path = fromX === toX
              ? `M ${fromX} ${fromY} V ${toY}`
              : `M ${fromX} ${fromY} V ${toY} H ${toX}`;
            return <path key={`${edge.from}->${edge.to}`} className="fx-version-graph-connection" d={path} data-from={edge.from} data-to={edge.to} />;
          })}
          {rows.map(({ node, depth }, index) => {
            const current = isCurrentVersionNode(node, currentTag, currentHead);
            const x = GRAPH_LANE_PADDING / 2 + depth * GRAPH_LANE_STEP;
            const y = index * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2;
            return <circle key={`marker:${node.id}`} className={`fx-version-graph-marker${current ? ' is-current' : ''}`} cx={x} cy={y} r={current ? 4 : 3.5} />;
          })}
        </svg>
      ) : null}
      {rows.map(({ node, depth, parentIds }) => {
        const tags = versionNodeTags(node);
        const current = isCurrentVersionNode(node, currentTag, currentHead);
        const parentLabels = parentIds.flatMap((parentId) => {
          const parent = nodeById.get(parentId);
          return parent === undefined ? [] : [versionNodeLabel(parent)];
        });
        return (
          <div
            key={node.id}
            className={`fx-version-graph-node${current ? ' is-current' : ''}`}
            data-commit={node.id}
            data-depth={depth}
            data-current={current ? 'true' : undefined}
            aria-current={current ? 'true' : undefined}
            aria-level={depth + 1}
            role="treeitem"
          >
            <div className="fx-version-graph-content">
              <div className="fx-version-graph-primary">
                <span className="fx-version-graph-message" title={node.message || 'No commit message'}>{node.message || 'No commit message'}</span>
                <CopyCommitHash head={node.head} />
              </div>
              <div className="fx-version-graph-meta">
                {tags.map((tag) => {
                  const currentTagMatch = current && (
                    (currentTag !== null && currentTag !== undefined && tag === currentTag)
                    || ((currentTag === null || currentTag === undefined) && currentHead === node.head)
                  );
                  return <span key={tag} className={`fx-version-graph-tag${currentTagMatch ? ' is-current' : ''}`}>{tag}</span>;
                })}
                {node.latest ? <span className="fx-version-graph-latest">Latest</span> : null}
                {parentLabels.length > 0 ? (
                  <span className="fx-version-graph-parent" title={`Based on ${parentLabels.join(', ')}`}>← {parentLabels.join(', ')}</span>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
