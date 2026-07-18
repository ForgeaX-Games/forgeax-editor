import { useMemo, useState, useCallback } from 'react';

interface TreeNode {
  name: string;
  fullPath: string;
  children: TreeNode[];
}

interface AssetFolderTreeProps {
  dirs: string[];
  selected: string;
  onSelect: (dir: string) => void;
}

function buildTree(dirs: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  const map = new Map<string, TreeNode>();

  for (const d of dirs) {
    const parts = d.split('/');
    let parent: TreeNode[] = root;
    let path = '';
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      let node = map.get(path);
      if (!node) {
        node = { name: part, fullPath: path, children: [] };
        map.set(path, node);
        parent.push(node);
      }
      parent = node.children;
    }
  }
  return root;
}

const STORAGE_KEY = 'forgeax.cb.expanded';

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set<string>();
  } catch { return new Set<string>(); }
}

function saveExpanded(s: Set<string>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...s])); } catch { /* noop */ }
}

export function AssetFolderTree({ dirs, selected, onSelect }: AssetFolderTreeProps) {
  const tree = useMemo(() => buildTree(dirs), [dirs]);
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);

  const toggle = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      saveExpanded(next);
      return next;
    });
  }, []);

  return (
    <div className="cb-tree">
      <div className={`cb-tree-item${selected === '' ? ' sel' : ''}`}
           onClick={() => onSelect('')}>
        <span className="cb-tree-icon">📁</span>
        <span className="cb-tree-label">All Assets</span>
      </div>
      {tree.map(node => (
        <FolderNode key={node.fullPath} node={node} depth={0}
                    selected={selected} expanded={expanded}
                    onSelect={onSelect} onToggle={toggle} />
      ))}
    </div>
  );
}

function FolderNode({ node, depth, selected, expanded, onSelect, onToggle }: {
  node: TreeNode; depth: number; selected: string;
  expanded: Set<string>;
  onSelect: (d: string) => void; onToggle: (d: string) => void;
}) {
  const isExpanded = expanded.has(node.fullPath);
  const isSel = selected === node.fullPath;
  const hasChildren = node.children.length > 0;

  return (
    <>
      <div className={`cb-tree-item${isSel ? ' sel' : ''}`}
           style={{ paddingLeft: `${8 + depth * 14}px` }}
           onClick={() => onSelect(node.fullPath)}>
        {hasChildren ? (
          <span className="cb-tree-arrow" onClick={(e) => { e.stopPropagation(); onToggle(node.fullPath); }}>
            {isExpanded ? '▾' : '▸'}
          </span>
        ) : <span className="cb-tree-arrow-sp" />}
        <span className="cb-tree-icon">📁</span>
        <span className="cb-tree-label">{node.name}</span>
      </div>
      {isExpanded && node.children.map(c => (
        <FolderNode key={c.fullPath} node={c} depth={depth + 1}
                    selected={selected} expanded={expanded}
                    onSelect={onSelect} onToggle={onToggle} />
      ))}
    </>
  );
}
