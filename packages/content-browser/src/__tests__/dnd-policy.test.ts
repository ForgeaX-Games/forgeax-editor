// Shallow guards for the Content Browser move-DnD policy — the pure, framework-
// free core (canDrag / accept + verdict / conflict detection / op mapping). These
// are the rules the grid tiles, tree rows and grid-blank drop zone all defer to,
// so pinning them here catches a regression without needing a DOM or a drag.

import { describe, expect, it } from 'bun:test';
import {
  canDrag,
  evaluateDrop,
  findMoveConflicts,
  moveOpForEntry,
} from '../dnd/policy';
import type { CBDragEntry, CBDragPayload, CBDropTarget } from '../dnd/model';

const folderEntry = (path: string): CBDragEntry => ({ kind: 'folder', path, name: path.slice(path.lastIndexOf('/') + 1) });
const fileEntry = (path: string): CBDragEntry => ({ kind: 'file', path, name: path.slice(path.lastIndexOf('/') + 1) });
const payload = (...entries: CBDragEntry[]): CBDragPayload => ({ source: 'grid', entries });
const folderTile = (path: string): CBDropTarget => ({ kind: 'folder-tile', path });

describe('canDrag', () => {
  it('rejects null and a root-level folder (no parent to leave)', () => {
    expect(canDrag(null)).toBe(false);
    expect(canDrag(folderEntry(''))).toBe(false);
  });
  it('accepts a normal folder or file', () => {
    expect(canDrag(folderEntry('assets/props'))).toBe(true);
    expect(canDrag(fileEntry('assets/props/chair.glb'))).toBe(true);
  });
});

describe('evaluateDrop', () => {
  it('rejects an empty / missing payload', () => {
    expect(evaluateDrop(null, folderTile('assets'))).toEqual({ ok: false, reason: 'no-payload' });
    expect(evaluateDrop(payload(), folderTile('assets'))).toEqual({ ok: false, reason: 'no-payload' });
  });

  it('rejects dropping a folder onto itself', () => {
    expect(evaluateDrop(payload(folderEntry('assets/props')), folderTile('assets/props')))
      .toEqual({ ok: false, reason: 'self' });
  });

  it('rejects moving a folder into its own descendant', () => {
    expect(evaluateDrop(payload(folderEntry('assets/props')), folderTile('assets/props/sub')))
      .toEqual({ ok: false, reason: 'descendant' });
  });

  it('rejects a move whose target is the subject\'s current parent (no-op)', () => {
    expect(evaluateDrop(payload(fileEntry('assets/props/chair.glb')), folderTile('assets/props')))
      .toEqual({ ok: false, reason: 'same-parent' });
  });

  it('accepts a genuine cross-directory move', () => {
    expect(evaluateDrop(payload(fileEntry('assets/props/chair.glb')), folderTile('assets/staging')))
      .toEqual({ ok: true });
    expect(evaluateDrop(payload(folderEntry('assets/props')), folderTile('assets/archive')))
      .toEqual({ ok: true });
  });

  it('rejects the whole batch if ANY entry is illegal', () => {
    const mixed = payload(fileEntry('assets/props/chair.glb'), folderEntry('assets/x'));
    // second entry's target equals its parent -> same-parent kills the batch.
    expect(evaluateDrop(mixed, folderTile('assets')).ok).toBe(false);
  });
});

describe('findMoveConflicts', () => {
  it('flags only the entries whose basename already exists in the destination', () => {
    const p = payload(fileEntry('assets/a/chair.glb'), fileEntry('assets/a/lamp.glb'));
    const existing = new Set(['chair.glb', 'table.glb']);
    const conflicts = findMoveConflicts(p, existing);
    expect(conflicts.map((c) => c.name)).toEqual(['chair.glb']);
  });

  it('returns nothing when the destination is clear', () => {
    const p = payload(fileEntry('assets/a/chair.glb'));
    expect(findMoveConflicts(p, new Set(['other.glb']))).toEqual([]);
  });
});

describe('moveOpForEntry', () => {
  it('maps a folder to moveDirectory and a file to moveSourceFile, preserving path + targetDir', () => {
    expect(moveOpForEntry(folderEntry('assets/props'), 'assets/archive'))
      .toEqual({ kind: 'moveDirectory', path: 'assets/props', targetDir: 'assets/archive' });
    expect(moveOpForEntry(fileEntry('assets/props/chair.glb'), 'assets/staging'))
      .toEqual({ kind: 'moveSourceFile', path: 'assets/props/chair.glb', targetDir: 'assets/staging' });
  });
});
