// scan/scan-diff.ts — three-tier incremental diff (G1: L0/L1/L2).
//
// Pure functions that take previous scan state + current filesystem stats and
// produce categorized change sets: unchanged, new, changed (needs reimport),
// false-positives (touch/copy), orphaned (source deleted but meta exists).
//
// Anchors:
//   todo: 2026-07-09 startup-asset-scan-auto-import G1

import type { DirEntry, ScanEntry } from './scan-state';
import type { ScanDiagnostic } from './scan-diagnostic';

// ── Input shapes (from platform-io scan API) ──────────────────────────────────

export interface DirStat {
  mtime: number;
}

export interface FileStat {
  mtime: number;
  size: number;
}

// ── Diff output ───────────────────────────────────────────────────────────────

export interface ScanDiff {
  /** New source files (disk has, scan-state doesn't) — need meta + import. */
  added: string[];
  /** Files where mtime/size changed AND content hash differs — need reimport. */
  changed: string[];
  /** Files where mtime changed but content hash is the same — false positive. */
  falsePositives: string[];
  /** Files where mtime hasn't changed (L1 pass) — skip entirely. */
  unchanged: string[];
  /** Entries in scan-state whose source file no longer exists on disk. */
  orphaned: string[];
  /** Directories whose mtime changed (need deeper inspection). */
  changedDirs: string[];
  /** Directories whose mtime hasn't changed — skip whole subtree. */
  unchangedDirs: string[];
}

// ── L0: directory-level change detection ──────────────────────────────────────

/**
 * Compare current directory stats against previous scan-state dirs.
 * Returns lists of changed (need deeper scan) and unchanged (skip subtree) directories.
 */
export function diffDirs(
  prevDirs: Record<string, DirEntry>,
  currentDirs: Record<string, DirStat>,
): { changed: string[]; unchanged: string[] } {
  const changed: string[] = [];
  const unchanged: string[] = [];

  for (const [path, stat] of Object.entries(currentDirs)) {
    const prev = prevDirs[path];
    if (!prev || prev.mtime !== stat.mtime) {
      changed.push(path);
    } else {
      unchanged.push(path);
    }
  }

  return { changed, unchanged };
}

// ── L1: file-level mtime+size fast check ──────────────────────────────────────

/**
 * Compare current file stats against previous scan-state entries.
 * Only processes files under directories that changed at L0.
 */
export function diffFilesL1(
  prevEntries: Record<string, ScanEntry>,
  currentFiles: Record<string, FileStat>,
  changedDirs: Set<string>,
): {
  unchanged: string[];
  maybeChanged: string[];
  added: string[];
  orphaned: string[];
} {
  const unchanged: string[] = [];
  const maybeChanged: string[] = [];
  const added: string[] = [];
  const orphaned: string[] = [];

  // New or changed files
  for (const [path, stat] of Object.entries(currentFiles)) {
    // Only inspect files in changed directories
    const dir = path.substring(0, path.lastIndexOf('/'));
    if (!changedDirs.has(dir) && !changedDirs.has(path)) {
      unchanged.push(path);
      continue;
    }

    const prev = prevEntries[path];
    if (!prev) {
      added.push(path);
    } else if (prev.mtime !== stat.mtime || prev.size !== stat.size) {
      // If size changed, it's definitely changed (skip L2)
      if (prev.size !== stat.size) {
        maybeChanged.push(path);
      } else {
        // mtime changed but size same — need L2 hash check
        maybeChanged.push(path);
      }
    } else {
      unchanged.push(path);
    }
  }

  // Orphaned: entries in state whose source files no longer exist
  for (const path of Object.keys(prevEntries)) {
    if (!(path in currentFiles)) {
      orphaned.push(path);
    }
  }

  return { unchanged, maybeChanged, added, orphaned };
}

// ── L2: content hash check (false-positive guard) ─────────────────────────────

/**
 * Check which "maybeChanged" files actually changed by comparing content hashes.
 * Files with same hash are false positives (mtime changed due to touch/copy).
 *
 * @param maybeChanged - paths that differed at L1
 * @param prevEntries - previous scan-state entries (for cached hashes)
 * @param currentHashes - map of path → xxHash64 string from current files
 */
export function diffFilesL2(
  maybeChanged: string[],
  prevEntries: Record<string, ScanEntry>,
  currentHashes: Record<string, string>,
): { changed: string[]; falsePositives: string[] } {
  const changed: string[] = [];
  const falsePositives: string[] = [];

  for (const path of maybeChanged) {
    const prev = prevEntries[path];
    const currentHash = currentHashes[path];
    if (!currentHash) {
      // Couldn't compute hash — treat as changed (conservative)
      changed.push(path);
    } else if (prev?.contentHash && prev.contentHash === currentHash) {
      // Same content, just mtime changed — false positive
      falsePositives.push(path);
    } else {
      // Content truly changed
      changed.push(path);
    }
  }

  return { changed, falsePositives };
}

// ── Combined full diff ────────────────────────────────────────────────────────

/**
 * Run the full three-tier diff pipeline.
 */
export function fullScanDiff(
  prevDirs: Record<string, DirEntry>,
  prevEntries: Record<string, ScanEntry>,
  currentDirs: Record<string, DirStat>,
  currentFiles: Record<string, FileStat>,
  currentHashes?: Record<string, string>,
): ScanDiff {
  const { changed: changedDirList, unchanged: unchangedDirs } = diffDirs(prevDirs, currentDirs);
  const changedDirSet = new Set(changedDirList);

  const l1 = diffFilesL1(prevEntries, currentFiles, changedDirSet);

  let changed: string[] = [];
  let falsePositives: string[] = [];

  if (currentHashes && l1.maybeChanged.length > 0) {
    const l2 = diffFilesL2(l1.maybeChanged, prevEntries, currentHashes);
    changed = l2.changed;
    falsePositives = l2.falsePositives;
  } else {
    // No hashes available — all maybeChanged are treated as changed
    changed = l1.maybeChanged;
  }

  return {
    added: l1.added,
    changed,
    falsePositives,
    unchanged: l1.unchanged,
    orphaned: l1.orphaned,
    changedDirs: changedDirList,
    unchangedDirs,
  };
}
