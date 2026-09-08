import { describe, expect, test } from 'bun:test';
import {
  createGenerationTransitionTrace,
  type GenerationTransitionTrace,
} from '../../bridge';
import { classifySwitchFailure } from '../error-projection';
import { evaluateSwitchPreflight } from '../switch-applier';
import { createVersionControlRecoveryController } from '../recovery';

describe('dual host generation switch contract', () => {
  test.each(['standalone', 'studio'] as const)('%s keeps terminal after successor ready', (host) => {
    const trace: GenerationTransitionTrace = createGenerationTransitionTrace();
    trace.record('checkout-complete');
    trace.record('old-runtime-barrier');
    trace.record('old-runtime-teardown');
    trace.record('successor-cold-ready');
    trace.record('lease-swap');
    trace.record('operation-terminal');
    expect(trace.host(host).events).toEqual([
      'checkout-complete',
      'old-runtime-barrier',
      'old-runtime-teardown',
      'successor-cold-ready',
      'lease-swap',
      'operation-terminal',
    ]);
    expect(trace.host(host).terminalBeforeColdReady).toBe(false);
    expect(trace.host(host).oldProjection).toBe('stale');
  });

  test('both hosts preserve old state on failure and freeze uncertain state', () => {
    const proven = classifySwitchFailure({
      code: 'version-control-checkout-failed',
      headBefore: 'commit-a',
      headAfter: 'commit-a',
      dirtyBefore: false,
      dirtyAfter: false,
      generation: 3,
    });
    expect(proven.mode).toBe('retain-old-runtime');
    const recovery = createVersionControlRecoveryController(3);
    recovery.freeze({ generation: 3, error: 'process interrupted' });
    expect(recovery.canMutate(3)).toMatchObject({ ok: false, error: { code: 'version-control-external-inspection-required' } });
    expect(recovery.reconcile({ generation: 3, repositoryIdentity: 'repo', head: 'commit-b', snapshotId: 'snapshot-b' })).toEqual({ ok: true });
    expect(recovery.canMutate(3)).toEqual({ ok: true });
  });

  test.each(['standalone', 'studio'] as const)('%s projects the same blocking error matrix', (host) => {
    const cases = [
      ['play', 'version-control-play-active'],
      ['staging', 'version-control-staging-active'],
      ['dirty', 'version-control-worktree-dirty'],
      ['target', 'version-control-target-stale'],
      ['operation', 'version-control-operation-busy'],
      ['root', 'version-control-root-mismatch'],
      ['recovery', 'version-control-recovery-required'],
    ] as const;
    expect(cases).toHaveLength(7);
    for (const [label, code] of cases) {
      const failure = evaluateSwitchPreflight({
        playActive: label === 'play',
        stagingActive: label === 'staging',
        dirty: label === 'dirty',
        untracked: false,
        targetDrifted: label === 'target',
        writeOperationActive: label === 'operation',
        rootMatches: label !== 'root',
        repositoryRecoveryRequired: label === 'recovery',
        generation: 4,
      });
      expect(failure.ok, `${host}:${label}`).toBe(false);
      if (!failure.ok) {
        expect(failure.error.code, `${host}:${label}`).toBe(code);
        expect(failure.error.recoveryActions.length, `${host}:${label}`).toBeGreaterThan(0);
      }
    }
  });

  test('switch transition never exposes terminal before successor cold-ready', () => {
    const trace = createGenerationTransitionTrace();
    trace.record('checkout-complete');
    trace.record('old-runtime-barrier');
    trace.record('old-runtime-teardown');
    trace.record('successor-cold-ready');
    trace.record('lease-swap');
    trace.record('operation-terminal');
    for (const host of ['standalone', 'studio'] as const) {
      const observed = trace.host(host);
      expect(observed.terminalBeforeColdReady, host).toBe(false);
      expect(observed.oldProjection, host).toBe('stale');
    }
  });
});
