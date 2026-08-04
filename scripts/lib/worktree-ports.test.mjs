import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  allocateWorktreePorts,
  DEFAULT_PORTS,
  portsForSlot,
  readWorktreePorts,
  resolveWorktreePorts,
  writeWorktreePorts,
} from './worktree-ports.ts';

describe('worktree port allocation policy', () => {
  test('derives non-overlapping stable slots from the main profile', () => {
    const slot0 = portsForSlot(0);
    const slot1 = portsForSlot(1);
    const slot2 = portsForSlot(2);

    expect(slot0).toEqual(DEFAULT_PORTS);
    expect(new Set(Object.values(slot1)).size).toBe(6);
    expect(Object.values(slot1).filter((port) => Object.values(slot0).includes(port))).toEqual([]);
    expect(Object.values(slot2).filter((port) => Object.values(slot1).includes(port))).toEqual([]);
  });

  test('round-trips the ignored worktree config and keeps explicit env overrides first', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-worktree-ports-'));
    try {
      const assigned = portsForSlot(3);
      writeWorktreePorts(root, assigned);
      expect(readWorktreePorts(root)).toEqual(assigned);
      expect(resolveWorktreePorts(root, { FORGEAX_PLAY_RUNTIME_PORT: '16000' })).toMatchObject({
        standalone: assigned.standalone,
        playRuntime: 16000,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('allocates a free slot and advances after persisting it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-worktree-ports-'));
    try {
      const first = await allocateWorktreePorts(root);
      writeWorktreePorts(root, first.ports);
      const second = await allocateWorktreePorts(root);
      expect(second.slot).toBeGreaterThan(first.slot);
      expect(Object.values(second.ports).some((port) => Object.values(first.ports).includes(port))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
