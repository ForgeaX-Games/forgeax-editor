import { describe, expect, test } from 'bun:test';
import {
  classifySwitchFailure,
  type SwitchFailureObservation,
} from '../error-projection';

describe('switch failure projection', () => {
  test('retains the old Runtime for a proven no-change checkout failure', () => {
    const observation: SwitchFailureObservation = {
      code: 'version-control-checkout-failed',
      headBefore: 'commit-a',
      headAfter: 'commit-a',
      dirtyBefore: false,
      dirtyAfter: false,
      generation: 7,
    };
    expect(classifySwitchFailure(observation)).toEqual({
      mode: 'retain-old-runtime',
      generation: 7,
      error: expect.objectContaining({ code: 'version-control-checkout-failed' }),
      recoveryActions: ['version-control.refresh', 'run.retry'],
    });
  });

  test('freezes all new mutation when repository state cannot be proven', () => {
    const observation: SwitchFailureObservation = {
      code: 'version-control-command-failed',
      headBefore: 'commit-a',
      headAfter: null,
      dirtyBefore: false,
      dirtyAfter: null,
      generation: 7,
    };
    expect(classifySwitchFailure(observation)).toEqual({
      mode: 'external-inspection-required',
      generation: 7,
      error: expect.objectContaining({ code: 'version-control-external-inspection-required' }),
      mutation: 'rejected',
      recoveryActions: ['version-control.refresh', 'version-control.reconcile'],
    });
  });
});
