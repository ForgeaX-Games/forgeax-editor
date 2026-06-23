import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileCode2,
  FileJson,
  FileText,
  FileImage,
  FileAudio,
  File as FileIcon,
} from 'lucide-react';
import { useAppStore } from '../../store';

// P4.1 — FilesPanel fp-types ext-distribution mini-strip.
// Sibling to P4.0 AgentsPanel ap-tribes: a one-row legend above the tree
// that aggregates files by extension-family and lets the player jump to
// the first file of a family with a flash. 6 families (code / json /
// text / image / audio / other) use the same palette the existing
// fileIconFor mapping is already keyed on — so the dot color on each
// chip matches the icon color the player sees in the tree below. 0
// new endpoint / 0 store / 0 server change — pure local aggregate over
// the already-fetched tree. The single-file flash channel mirrors the
// pendingHighlightAgentId / flashAgentId hand-off used by ap-tribes,
// kept local here since FilesPanel is the only consumer.
//
// P4.49 — extend the «Σ total prefix» visual lexicon to FilesPanel.
// 5 sibling surfaces already speak this language: BusHealthLamp header
// chip (P4.48), AgentsHub header (P4.45), WbGallery stats (P4.46),
// AgentsPanel header (P4.47), BusAdminPanel summary (P4.42). FilesPanel
// was the last counter strip still using a stale `= N` prefix — pure
// visual unification, 0 behavior change. The total cell becomes a
// 3-part composite: `[vsep 1×9px amber] [Σ 9px 0.72 alpha currentColor]
// [N 9.5px tabular-nums]`, sitting at the right edge of .fp-types after
// the 6 family chips. The vsep separates "总量" from the per-family
// distribution semantically, same pattern AgentsHub/AgentsPanel use.

interface Node {
  type: 'dir' | 'file';
  name: string;
  path: string;
  children?: Node[];
}

type FileFamily = 'code' | 'json' | 'text' | 'image' | 'audio' | 'other';

const FAMILY_ORDER: ReadonlyArray<{ key: FileFamily; label: string }> = [
  { key: 'code', label: 'CODE' },
  { key: 'json', label: 'JSON' },
  { key: 'text', label: 'TEXT' },
  { key: 'image', label: 'IMG' },
  { key: 'audio', label: 'AUD' },
  { key: 'other', label: 'ETC' },
];

function familyOf(name: string): FileFamily {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'code';
  if (['json', 'lock'].includes(ext)) return 'json';
  if (['md', 'markdown', 'txt', 'rst'].includes(ext)) return 'text';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return 'audio';
  return 'other';
}

function fileIconFor(name: string) {
  switch (familyOf(name)) {
    case 'code': return FileCode2;
    case 'json': return FileJson;
    case 'text': return FileText;
    case 'image': return FileImage;
    case 'audio': return FileAudio;
    default: return FileIcon;
  }
}

interface FamilyAggregate {
  key: FileFamily;
  label: string;
  count: number;
  firstPath: string | null;
}

function aggregateFamilies(tree: Node | null): FamilyAggregate[] {
  const tally: Record<FileFamily, { count: number; firstPath: string | null }> = {
    code: { count: 0, firstPath: null },
    json: { count: 0, firstPath: null },
    text: { count: 0, firstPath: null },
    image: { count: 0, firstPath: null },
    audio: { count: 0, firstPath: null },
    other: { count: 0, firstPath: null },
  };
  const walk = (n: Node) => {
    if (n.type === 'file') {
      const fam = familyOf(n.name);
      tally[fam].count += 1;
      if (tally[fam].firstPath === null) tally[fam].firstPath = n.path;
      return;
    }
    for (const c of n.children ?? []) walk(c);
  };
  if (tree) walk(tree);
  return FAMILY_ORDER.map((m) => ({
    key: m.key,
    label: m.label,
    count: tally[m.key].count,
    firstPath: tally[m.key].firstPath,
  }));
}

// P4.54 — recursive file count under a directory node. Used by TreeRow.dir
// to render a 9px dim count badge after the folder name (`src 23`) so the
// player can size each folder without expanding it. Pure derive over the
// already-fetched tree, 0 new endpoint / 0 store / 0 poll. Cached per node
// via WeakMap keyed on the children array reference — tree is replaced
// wholesale on each 5s poll, so identity equality is enough.
const dirFileCountCache = new WeakMap<Node, number>();
function countFilesIn(node: Node): number {
  if (node.type === 'file') return 1;
  const cached = dirFileCountCache.get(node);
  if (cached !== undefined) return cached;
  let n = 0;
  for (const c of node.children ?? []) n += countFilesIn(c);
  dirFileCountCache.set(node, n);
  return n;
}

// Collect every ancestor dir path so we can auto-expand on jump.
function ancestorsOf(path: string, rootPath: string): string[] {
  const out: string[] = [];
  if (!path.startsWith(rootPath)) return out;
  const tail = path.slice(rootPath.length).replace(/^\//, '');
  if (!tail) return out;
  const parts = tail.split('/').slice(0, -1);
  let acc = rootPath;
  out.push(acc);
  for (const p of parts) {
    acc = `${acc}/${p}`;
    out.push(acc);
  }
  return out;
}

export function FilesPanel() {
  const openFile = useAppStore((s) => s.openFile);
  const activeFilePath = useAppStore((s) => s.activeFilePath);
  const pinnedSlug = useAppStore((s) => s.pinnedSlug);
  const [autoSlug, setAutoSlug] = useState<string | null>(null);
  const activeSlug = pinnedSlug ?? autoSlug;
  const [tree, setTree] = useState<Node | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Re-run when pinnedSlug changes — earlier version had [] deps + a
  // setInterval that closed over the initial pinnedSlug, so switching
  // project left the tree stuck on the old slug until full reload.
  //
  // expanded init is keyed by `isFirstLoad`: only the first successful
  // tree fetch for a given slug seeds the default expansion. Subsequent
  // 5s polls keep the user's manual expansion intact — earlier this same
  // block called setExpanded() unconditionally, which silently re-collapsed
  // every folder the user clicked into within 1-2s of opening it.
  useEffect(() => {
    let cancelled = false;
    let isFirstLoad = true;
    setLoading(true);
    setError(null);
    setTree(null);
    const load = async () => {
      try {
        const wb = await fetch('/api/workbench/agents?lang=zh').then((r) => r.json()) as { activeSlug?: string };
        if (cancelled) return;
        const slug = pinnedSlug ?? wb.activeSlug;
        if (!slug) {
          setError('no active game');
          setLoading(false);
          return;
        }
        setAutoSlug(wb.activeSlug ?? null);
        const tr = await fetch(`/api/files/tree?root=.forgeax/games/${encodeURIComponent(slug)}`).then((r) => r.json()) as { tree?: Node; error?: string };
        if (cancelled) return;
        if (tr.error || !tr.tree) {
          setError(tr.error ?? 'no tree');
        } else {
          setTree(tr.tree);
          if (isFirstLoad) {
            setExpanded(new Set([tr.tree.path, `${tr.tree.path}/src`, `${tr.tree.path}/design`]));
            isFirstLoad = false;
          }
        }
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [pinnedSlug]);

  return <FilesPanelView
    loading={loading}
    error={error}
    tree={tree}
    activeSlug={activeSlug}
    expanded={expanded}
    setExpanded={setExpanded}
    previewPath={activeFilePath}
    openFile={openFile}
  />;
}

interface ViewProps {
  loading: boolean;
  error: string | null;
  tree: Node | null;
  activeSlug: string | null;
  expanded: Set<string>;
  setExpanded: (s: Set<string>) => void;
  previewPath: string | null;
  openFile: (path: string) => Promise<void> | void;
}

function FilesPanelView({ loading, error, tree, activeSlug, expanded, setExpanded, previewPath, openFile }: ViewProps) {
  const [flashPath, setFlashPath] = useState<string | null>(null);
  const [pendingScrollPath, setPendingScrollPath] = useState<string | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const families = useMemo(() => aggregateFamilies(tree), [tree]);
  const total = useMemo(() => families.reduce((s, f) => s + f.count, 0), [families]);

  useEffect(() => () => {
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
  }, []);

  // Two-phase: click sets pendingScrollPath + expands ancestors → React
  // re-renders the new rows → this effect (re-run when expanded changes)
  // finds the row and runs scroll/focus/flash. Avoids the rAF-before-
  // commit race the naive inline approach hits.
  useEffect(() => {
    if (!pendingScrollPath) return;
    const el = document.querySelector<HTMLElement>(`[data-fp-path="${CSS.escape(pendingScrollPath)}"]`);
    if (!el) return; // not yet expanded — will re-fire on next expanded update
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.focus({ preventScroll: true });
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    setFlashPath(pendingScrollPath);
    const path = pendingScrollPath;
    setPendingScrollPath(null);
    flashTimerRef.current = window.setTimeout(() => {
      setFlashPath((cur) => (cur === path ? null : cur));
      flashTimerRef.current = null;
    }, 1500);
  }, [pendingScrollPath, expanded]);

  const onTypeClick = (fam: FamilyAggregate) => {
    if (!fam.firstPath || !tree) return;
    const next = new Set(expanded);
    for (const a of ancestorsOf(fam.firstPath, tree.path)) next.add(a);
    setExpanded(next);
    setPendingScrollPath(fam.firstPath);
  };

  if (loading) {
    return (
      <div className="files-panel">
        <div className="fp-header">
          <span className="fp-slug">.forgeax/games / {activeSlug ?? '…'}</span>
        </div>
        <div className="fp-empty">加载中...</div>
      </div>
    );
  }
  if (error || !tree) {
    return (
      <div className="files-panel">
        <div className="fp-header">
          <span className="fp-slug">.forgeax/games / {activeSlug ?? '—'}</span>
        </div>
        <div className="fp-empty">{error ?? 'empty'}</div>
      </div>
    );
  }

  return (
    <div className="files-panel rail-panel">
      <div className="fp-header">
        <span className="fp-slug">.forgeax/games / {activeSlug}</span>
      </div>
      <div className="fp-types" role="toolbar" aria-label="file type distribution">
        <span className="fp-types-label" aria-hidden="true">FILES</span>
        {families.filter((f) => f.count > 0).map((f) => (
          <button
            key={f.key}
            type="button"
            className={`fp-type-chip fam-${f.key}`}
            onClick={() => onTypeClick(f)}
            disabled={!f.firstPath}
            title={`${f.label} · ${f.count} 个文件${f.firstPath ? ` · 跳转到 ${f.firstPath.split('/').pop()}` : ''}`}
            aria-label={`${f.label} ${f.count} files — jump to first`}
          >
            <span className={`fp-type-dot fam-${f.key}`} aria-hidden="true" />
            <span className="fp-type-label">{f.label}</span>
            <span className="fp-type-count">{f.count}</span>
          </button>
        ))}
        {total > 0 && (
          <span
            className="fp-types-total"
            title={`Σ ${total} 个文件 · 按 6 个 family 拆分`}
            aria-label={`${total} files total across all families`}
          >
            <span className="fp-types-vsep" aria-hidden="true" />
            <span className="fp-types-sigma" aria-hidden="true">Σ</span>
            <span className="fp-types-total-n">{total}</span>
          </span>
        )}
      </div>
      <div className="file-tree reveal-stagger">
        <TreeRow
          node={tree}
          depth={0}
          expanded={expanded}
          setExpanded={setExpanded}
          activeFile={previewPath}
          flashPath={flashPath}
          onOpen={(p) => void openFile(p)}
        />
      </div>
    </div>
  );
}

interface RowProps {
  node: Node;
  depth: number;
  expanded: Set<string>;
  setExpanded: (s: Set<string>) => void;
  activeFile: string | null;
  flashPath: string | null;
  onOpen: (path: string) => void;
}

function TreeRow({ node, depth, expanded, setExpanded, activeFile, flashPath, onOpen }: RowProps) {
  if (node.type === 'dir') {
    const isOpen = expanded.has(node.path);
    const FolderGlyph = isOpen ? FolderOpen : Folder;
    const toggle = () => {
      const next = new Set(expanded);
      isOpen ? next.delete(node.path) : next.add(node.path);
      setExpanded(next);
    };
    const fileCount = countFilesIn(node);
    return (
      <>
        <button
          className="fp-row dir"
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={toggle}
          title={`${node.name} · ${fileCount} 个文件 · 单击 ${isOpen ? '折叠' : '展开'}`}
        >
          <span className="fp-chev">{isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</span>
          <FolderGlyph size={13} className="fp-folder-ico" />
          <span className="fp-name">{node.name}</span>
          {fileCount > 0 && (
            <span
              className="fp-dir-count"
              aria-label={`${fileCount} files in folder`}
            >
              {fileCount}
            </span>
          )}
        </button>
        {isOpen && (node.children ?? []).map((c) => (
          <TreeRow
            key={c.path}
            node={c}
            depth={depth + 1}
            expanded={expanded}
            setExpanded={setExpanded}
            activeFile={activeFile}
            flashPath={flashPath}
            onOpen={onOpen}
          />
        ))}
      </>
    );
  }
  const Icon = fileIconFor(node.name);
  const isActive = activeFile === node.path;
  const isFlash = flashPath === node.path;
  const fam = familyOf(node.name);
  return (
    <button
      className={`fp-row file fam-${fam} ${isActive ? 'active' : ''} ${isFlash ? 'is-flash' : ''}`}
      style={{ paddingLeft: 6 + depth * 12 + 14 }}
      onClick={() => onOpen(node.path)}
      title={node.path}
      data-fp-path={node.path}
    >
      <Icon size={13} className="fp-file-ico" />
      <span className="fp-name">{node.name}</span>
    </button>
  );
}
