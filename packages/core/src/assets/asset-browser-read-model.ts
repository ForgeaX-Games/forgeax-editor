// asset-browser-read-model — canonical read model for Content Browser data
// (editor data-operation-view convergence M2).
//
// This module owns only environment reads and the catalog/tree/sidecar join. It
// has no React dependency and never creates an AssetRegistry. Asset identity is
// catalog-only; sidecars contribute source/indexing state and diagnostics.

export interface AssetBrowserCatalogRoot {
  readonly root: string;
  readonly catalogPrefix: string;
}

export interface AssetBrowserRegistryEntry {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly relativeUrl: string;
  readonly refs?: readonly string[];
  readonly sourcePath?: string;
}

export interface AssetBrowserRegistry {
  listCatalog(): readonly AssetBrowserRegistryEntry[];
  refreshCatalog?: () => Promise<boolean>;
}

export interface AssetBrowserTreeNode {
  readonly type: 'dir' | 'file';
  readonly name: string;
  readonly path: string;
  readonly children?: readonly AssetBrowserTreeNode[];
}

export interface AssetBrowserFile {
  readonly path: string;
  readonly diskPath: string;
  readonly name: string;
}

export interface AssetBrowserDirectory {
  readonly path: string;
  readonly diskPath: string;
  readonly name: string;
}

export interface AssetBrowserAsset {
  readonly guid: string;
  readonly kind: string;
  readonly name: string;
  readonly relativeUrl: string;
  /** Original catalog coordinate for an inline `.pack.json` CRUD target. */
  readonly storageRelativeUrl: string;
  readonly sourcePath?: string;
  /** Original catalog coordinate for file mutations. `sourcePath` is projected
   * into the browser's declared-root coordinate space for joining and display;
   * this value deliberately remains in the file backend's address space. */
  readonly storageSourcePath?: string;
  readonly refs: readonly string[];
}

export type AssetSourcePhase = 'raw' | 'pending-index' | 'indexed' | 'invalid-meta';

export interface AssetSourceState {
  readonly sourcePath: string;
  readonly metaPath?: string;
  readonly phase: AssetSourcePhase;
  readonly catalogGuids: readonly string[];
  readonly observedMetaGuids: readonly string[];
}

export interface AssetBrowserDiagnostic {
  readonly code: 'TREE_READ_FAILED' | 'SIDECAR_READ_FAILED' | 'INVALID_META';
  readonly path?: string;
  readonly message: string;
}

export interface AssetBrowserSnapshot {
  readonly generation: number;
  readonly files: readonly AssetBrowserFile[];
  readonly directories: readonly AssetBrowserDirectory[];
  readonly assets: readonly AssetBrowserAsset[];
  readonly sources: readonly AssetSourceState[];
  readonly diagnostics: readonly AssetBrowserDiagnostic[];
}

export interface AssetBrowserReadModel {
  snapshot(): AssetBrowserSnapshot;
  subscribe(listener: (snapshot: AssetBrowserSnapshot) => void): () => void;
  refresh(hint?: 'directory-only' | 'pack-changed'): Promise<AssetBrowserSnapshot>;
}

export interface CreateAssetBrowserReadModelDeps {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  registry: AssetBrowserRegistry;
  resolveGamePath: (relativePath: string) => string;
  catalogRoots: readonly AssetBrowserCatalogRoot[];
}

interface SidecarObservation {
  sourcePath: string;
  metaPath: string;
  guids: string[];
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function projectCatalogPath(path: string, roots: readonly AssetBrowserCatalogRoot[]): string {
  const normalized = normalize(path);
  for (const root of roots) {
    const prefix = normalize(root.catalogPrefix).replace(/\/+$/, '');
    if (!prefix) continue;
    if (normalized === prefix) return normalize(root.root);
    if (normalized.startsWith(`${prefix}/`)) {
      return `${normalize(root.root)}/${normalized.slice(prefix.length + 1)}`;
    }
  }
  return normalized;
}

function relativeToGamePath(path: string, resolvedRoot: string): string {
  const normalized = normalize(path);
  const root = normalize(resolvedRoot).replace(/\/+$/, '');
  if (normalized === root) return '';
  if (root && normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return normalized;
}

function flattenTree(
  node: AssetBrowserTreeNode,
  resolvedRoot: string,
  files: AssetBrowserFile[],
  directories: AssetBrowserDirectory[],
): void {
  const relativePath = relativeToGamePath(node.path, resolvedRoot);
  if (node.type === 'file') {
    if (relativePath) files.push({ path: relativePath, diskPath: node.path, name: node.name });
  } else if (relativePath) {
    directories.push({ path: relativePath, diskPath: node.path, name: node.name });
  }
  for (const child of node.children ?? []) flattenTree(child, resolvedRoot, files, directories);
}

function sourcePathForSidecar(metaPath: string, source: unknown): string {
  const metaSource = typeof source === 'string' && source.trim() !== '' ? normalize(source) : '';
  const baseDir = metaPath.replace(/\/[^/]+$/, '');
  const candidate = metaSource.includes('/') ? metaSource : joinPath(baseDir, metaSource);
  return candidate || metaPath.replace(/\.meta\.json$/, '');
}

function diagnosticsForError(
  code: AssetBrowserDiagnostic['code'],
  path: string,
  err: unknown,
): AssetBrowserDiagnostic {
  return {
    code,
    path,
    message: (err as Error)?.message ?? String(err),
  };
}

export function createAssetBrowserReadModel(deps: CreateAssetBrowserReadModelDeps): AssetBrowserReadModel {
  let current: AssetBrowserSnapshot = {
    generation: 0,
    files: [],
    directories: [],
    assets: [],
    sources: [],
    diagnostics: [],
  };
  let nextGeneration = 0;
  let latestGeneration = 0;
  const listeners = new Set<(snapshot: AssetBrowserSnapshot) => void>();

  const publish = (snapshot: AssetBrowserSnapshot): void => {
    current = snapshot;
    for (const listener of listeners) listener(snapshot);
  };

  const readTree = async (): Promise<{ tree: AssetBrowserTreeNode | null; diagnostics: AssetBrowserDiagnostic[] }> => {
    try {
      const rootPath = deps.resolveGamePath('');
      const response = await deps.fetch(`/api/files/tree?root=${encodeURIComponent(rootPath)}&optional=1`, { cache: 'no-store' });
      if (!response.ok) {
        return { tree: null, diagnostics: [diagnosticsForError('TREE_READ_FAILED', rootPath, `HTTP ${response.status}`)] };
      }
      const body = await response.json() as { tree?: AssetBrowserTreeNode | null };
      return { tree: body.tree ?? null, diagnostics: [] };
    } catch (err) {
      return { tree: null, diagnostics: [diagnosticsForError('TREE_READ_FAILED', '', err)] };
    }
  };

  const refresh = async (hint?: 'directory-only' | 'pack-changed'): Promise<AssetBrowserSnapshot> => {
    const generation = ++nextGeneration;
    latestGeneration = generation;
    const treePromise = readTree();
    const catalogPromise = hint === 'directory-only'
      ? Promise.resolve<readonly AssetBrowserRegistryEntry[]>(deps.registry.listCatalog())
      : (deps.registry.refreshCatalog ? deps.registry.refreshCatalog().catch(() => false).then(() => deps.registry.listCatalog()) : Promise.resolve(deps.registry.listCatalog()));
    const [{ tree, diagnostics }, catalogRows] = await Promise.all([treePromise, catalogPromise]);

    const files: AssetBrowserFile[] = [];
    const directories: AssetBrowserDirectory[] = [];
    if (tree) flattenTree(tree, deps.resolveGamePath(''), files, directories);
    files.sort((a, b) => a.path.localeCompare(b.path));
    directories.sort((a, b) => a.path.localeCompare(b.path));

    const assets: AssetBrowserAsset[] = [];
    const seenGuids = new Set<string>();
    const catalogBySource = new Map<string, string[]>();
    for (const row of catalogRows) {
      const guid = row.guid.toLowerCase();
      if (seenGuids.has(guid)) continue;
      seenGuids.add(guid);
      const relativeUrl = projectCatalogPath(row.relativeUrl, deps.catalogRoots);
      const sourcePath = row.sourcePath === undefined ? undefined : projectCatalogPath(row.sourcePath, deps.catalogRoots);
      assets.push({
        guid,
        kind: row.kind,
        name: row.name ?? guid.slice(0, 8),
        relativeUrl,
        storageRelativeUrl: row.relativeUrl,
        ...(sourcePath ? { sourcePath } : {}),
        ...(row.sourcePath ? { storageSourcePath: row.sourcePath } : {}),
        refs: [...(row.refs ?? [])],
      });
      if (sourcePath) catalogBySource.set(sourcePath, [...(catalogBySource.get(sourcePath) ?? []), guid]);
    }

    const sidecars: SidecarObservation[] = [];
    const sidecarDiagnostics: AssetBrowserDiagnostic[] = [];
    await Promise.all(files.filter((file) => file.path.endsWith('.meta.json')).map(async (file) => {
      try {
        const response = await deps.fetch(`/api/files/raw?path=${encodeURIComponent(file.diskPath)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json() as { source?: unknown; subAssets?: unknown };
        if (!Array.isArray(json.subAssets)) throw new Error('meta sidecar subAssets must be an array');
        const guids = json.subAssets
          .map((entry) => (entry && typeof entry === 'object' ? (entry as { guid?: unknown }).guid : undefined))
          .filter((guid): guid is string => typeof guid === 'string' && guid.length > 0)
          .map((guid) => guid.toLowerCase());
        sidecars.push({ sourcePath: sourcePathForSidecar(file.path, json.source), metaPath: file.path, guids });
      } catch (err) {
        sidecarDiagnostics.push(diagnosticsForError('INVALID_META', file.path, err));
      }
    }));

    const sourcePaths = new Set<string>(catalogBySource.keys());
    // A source file is still observable before either its sidecar or registry
    // entry exists. Keep it as a raw source state; it is not an asset row.
    for (const file of files) {
      if (!file.path.endsWith('.meta.json')) sourcePaths.add(file.path);
    }
    for (const sidecar of sidecars) sourcePaths.add(sidecar.sourcePath);
    const sidecarBySource = new Map<string, SidecarObservation>();
    for (const sidecar of sidecars) sidecarBySource.set(sidecar.sourcePath, sidecar);
    for (const diagnostic of sidecarDiagnostics) sourcePaths.add(diagnostic.path?.replace(/\.meta\.json$/, '') ?? '');

    const sources: AssetSourceState[] = [];
    for (const sourcePath of sourcePaths) {
      if (!sourcePath) continue;
      const sidecar = sidecarBySource.get(sourcePath);
      const catalogGuids = catalogBySource.get(sourcePath) ?? [];
      const invalidMeta = sidecarDiagnostics.some((diagnostic) => diagnostic.path === `${sourcePath}.meta.json`);
      const observedMetaGuids = sidecar?.guids ?? [];
      const phase: AssetSourcePhase = invalidMeta
        ? 'invalid-meta'
        : catalogGuids.length > 0
          ? 'indexed'
          : observedMetaGuids.length > 0
            ? 'pending-index'
            : 'raw';
      sources.push({ sourcePath, ...(sidecar ? { metaPath: sidecar.metaPath } : {}), phase, catalogGuids, observedMetaGuids });
    }
    sources.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));

    const snapshot: AssetBrowserSnapshot = Object.freeze({
      generation,
      files: Object.freeze(files),
      directories: Object.freeze(directories),
      assets: Object.freeze(assets),
      sources: Object.freeze(sources),
      diagnostics: Object.freeze([...diagnostics, ...sidecarDiagnostics]),
    });
    if (generation === latestGeneration) publish(snapshot);
    return generation === latestGeneration ? snapshot : current;
  };

  return {
    snapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
  };
}
