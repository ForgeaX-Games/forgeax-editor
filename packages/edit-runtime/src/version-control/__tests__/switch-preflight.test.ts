import { describe, expect, test } from 'bun:test';
import {
  evaluateSwitchPreflight,
  type SwitchPreflightInput,
} from '../switch-applier';

const ready: SwitchPreflightInput = {
  playActive: false,
  stagingActive: false,
  dirty: false,
  untracked: false,
  targetDrifted: false,
  writeOperationActive: false,
  rootMatches: true,
  repositoryRecoveryRequired: false,
  generation: 4,
};

describe('version control switch preflight', () => {
  test.each([
    ['play', { playActive: true }, 'version-control-play-active'],
    ['staging', { stagingActive: true }, 'version-control-staging-active'],
    ['dirty', { dirty: true }, 'version-control-worktree-dirty'],
    ['untracked', { untracked: true }, 'version-control-worktree-dirty'],
    ['target drift', { targetDrifted: true }, 'version-control-target-stale'],
    ['write operation', { writeOperationActive: true }, 'version-control-operation-busy'],
    ['root mismatch', { rootMatches: false }, 'version-control-root-mismatch'],
    ['recovery', { repositoryRecoveryRequired: true }, 'version-control-recovery-required'],
  ])('%s is rejected without a destructive side effect', (_name, change, code) => {
    const result = evaluateSwitchPreflight({ ...ready, ...change });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(code);
    expect(result.error.recoveryActions.length).toBeGreaterThan(0);
    expect(result.sideEffects).toEqual({ checkout: false, deleteFiles: false, moveRefs: false, writeGeneration: false });
    expect(result.generation).toBe(ready.generation);
  });

  test('returns a transition token only when every guard is ready', () => {
    const result = evaluateSwitchPreflight(ready);
    expect(result).toMatchObject({
      ok: true,
      generation: 4,
      sideEffects: { checkout: false, deleteFiles: false, moveRefs: false, writeGeneration: false },
    });
    if (result.ok) expect(result.transitionId).toMatch(/^switch-transition-/);
  });
});
