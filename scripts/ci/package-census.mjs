import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const CENSUS_SCHEMA_VERSION = 'forgeax-package-census/v1';

function normalizePath(path) {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function admission(path, observed, hint) {
  return {
    code: 'workspace-not-materialized',
    path,
    expected: 'materialized workspace package or initialized gitlink root',
    observed,
    hint,
  };
}

function patternsFromManifest(manifest) {
  if (Array.isArray(manifest?.workspaces)) return manifest.workspaces;
  if (Array.isArray(manifest?.workspaces?.packages)) return manifest.workspaces.packages;
  return [];
}

function discoverGitlinkRoots(rootDir) {
  try {
    const output = execFileSync('git', ['ls-files', '--stage'], { cwd: rootDir, encoding: 'utf8' });
    return output
      .split('\n')
      .map((line) => line.match(/^160000\s+[^\s]+\s+0\t(.+)$/)?.[1])
      .filter(Boolean)
      .map(normalizePath);
  } catch {
    return [];
  }
}

function hasPrefix(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function readPackage(rootDir, path) {
  const manifestPath = join(rootDir, path, 'package.json');
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function expandPattern(rootDir, pattern) {
  const segments = normalizePath(pattern).split('/').filter(Boolean);
  const paths = [];
  function visit(index, current) {
    if (index === segments.length) {
      paths.push(normalizePath(relative(rootDir, current)));
      return;
    }
    const segment = segments[index];
    if (!segment.includes('*')) {
      visit(index + 1, join(current, segment));
      return;
    }
    if (!existsSync(current)) return;
    for (const child of readdirSync(current)) {
      if (child.startsWith('.')) continue;
      const childPath = join(current, child);
      if (statSync(childPath).isDirectory()) visit(index + 1, childPath);
    }
  }
  visit(0, rootDir);
  return paths;
}

function filesystemInput(rootDir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  } catch {
    return { workspacePatterns: [], gitlinkRoots: [], entries: [], rootManifestMissing: true };
  }
  const gitlinkRoots = discoverGitlinkRoots(rootDir);
  const candidatePaths = new Set(patternsFromManifest(manifest).flatMap((pattern) => expandPattern(rootDir, pattern)));
  for (const gitlinkRoot of gitlinkRoots) candidatePaths.add(gitlinkRoot);
  const entries = [...candidatePaths].map((path) => {
    const gitlinkRoot = gitlinkRoots.find((root) => root === path);
    if (gitlinkRoot) {
      const absolutePath = join(rootDir, path);
      const initialized = existsSync(absolutePath) && readdirSync(absolutePath).length > 0;
      return { path, kind: 'gitlink', initialized, packageJson: initialized ? readPackage(rootDir, path) : undefined };
    }
    const packageJson = readPackage(rootDir, path);
    return packageJson ? { path, kind: 'package', packageJson } : { path, kind: 'directory' };
  });
  return { workspacePatterns: patternsFromManifest(manifest), gitlinkRoots, entries };
}

function surfaceFor(entry, gitlinkRoots) {
  const path = normalizePath(entry.path);
  const gitlinkRoot = [...gitlinkRoots].sort((left, right) => right.length - left.length).find((root) => hasPrefix(path, root));
  if (gitlinkRoot && path !== gitlinkRoot) return null;
  if (entry.kind === 'gitlink') {
    const materialization = entry.initialized ? 'materialized' : 'uninitialized';
    return { path, kind: 'gitlink-root', materialization, packageJson: entry.packageJson };
  }
  if (entry.kind === 'directory') return { path, kind: 'workspace-surface', materialization: 'empty-directory' };
  return { path, kind: 'workspace-package', materialization: 'materialized', packageJson: entry.packageJson };
}

export function discoverPackageCensus(input = {}) {
  const rootDir = resolve(input.rootDir ?? process.cwd());
  const source = Array.isArray(input.entries) ? input : filesystemInput(rootDir);
  const gitlinkRoots = new Set((source.gitlinkRoots ?? []).map(normalizePath));
  const entries = [...(source.entries ?? [])];
  for (const root of gitlinkRoots) {
    if (!entries.some((entry) => normalizePath(entry.path) === root)) {
      entries.push({ path: root, kind: 'gitlink', initialized: false });
    }
  }
  const surfaces = entries
    .map((entry) => surfaceFor(entry, gitlinkRoots))
    .filter(Boolean)
    .sort((left, right) => left.path.localeCompare(right.path));
  const admissions = [];
  if (source.rootManifestMissing) admissions.push(admission('.', 'root package.json missing or invalid', 'Restore a readable root package.json before expanding workspaces.'));
  for (const surface of surfaces) {
    if (surface.materialization === 'materialized') continue;
    admissions.push(admission(surface.path, surface.materialization, `Materialize ${surface.path} or remove it from the workspace input.`));
  }
  return {
    schemaVersion: CENSUS_SCHEMA_VERSION,
    workspacePatterns: [...(source.workspacePatterns ?? [])],
    surfaces,
    admissions,
    status: admissions.length > 0 ? 'admission' : 'ready',
  };
}

export function packageCensusFromRoot(rootDir = process.cwd()) {
  return discoverPackageCensus({ rootDir });
}
