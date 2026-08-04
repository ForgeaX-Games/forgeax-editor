import { describe, expect, test } from 'bun:test';
import {
  reduceSourceTerminal,
  type SourceTerminalState,
} from '../io/operation-runs';
import type { CommandError } from '../types';

describe('source operation terminal reducer', () => {
  test('keeps CAS committed runs non-cancellable and terminal exactly once', () => {
    let state: SourceTerminalState = { phase: 'accepted', terminal: null };
    state = reduceSourceTerminal(state, { type: 'cas-committed' });
    expect(reduceSourceTerminal(state, { type: 'cancel-requested' })).toMatchObject({
      phase: 'cas-committed',
      terminal: null,
      error: { code: 'asset-operation-cas-committed' },
    });

    state = reduceSourceTerminal(state, { type: 'publication-succeeded' });
    expect(state).toEqual({ phase: 'published', terminal: 'succeeded' });
    expect(reduceSourceTerminal(state, {
      type: 'publication-failed',
      error: structuredError('asset-cook-failed', 'cook', 'req-terminal', 'run-terminal'),
    })).toEqual(state);
  });

  test('retains all structured phase facts until the single terminal is reduced', () => {
    const error = structuredError('asset-catalog-subscription-gap', 'gap', 'req-gap', 'run-gap');
    const state = reduceSourceTerminal(
      { phase: 'accepted', terminal: null },
      { type: 'publication-failed', error },
    );

    expect(state).toMatchObject({
      phase: 'accepted',
      terminal: 'failed',
      error: {
        code: 'asset-catalog-subscription-gap',
        phase: 'gap',
        requestId: 'req-gap',
        runId: 'run-gap',
        expected: 'catalog:r2',
        actual: 'catalog:r0',
        recoveryActions: ['catalog.reconcile'],
      },
    });
    expect(reduceSourceTerminal(state, { type: 'publication-succeeded' })).toEqual(state);
  });

  test('allows cancellation before CAS and records a cancelled terminal', () => {
    const state = reduceSourceTerminal(
      { phase: 'accepted', terminal: null },
      { type: 'cancel-requested' },
    );
    expect(state).toEqual({ phase: 'accepted', terminal: 'cancelled' });
  });
});

function structuredError(
  code: CommandError['code'],
  phase: 'cook' | 'gap',
  requestId: string,
  runId: string,
): CommandError {
  return {
    code,
    phase,
    runId,
    requestId,
    subjectRef: { kind: 'asset-source', id: 'guid:mesh', guid: 'guid:mesh', sourceKey: 'source:mesh' },
    expected: phase === 'gap' ? 'catalog:r2' : 'ddc:desired',
    actual: phase === 'gap' ? 'catalog:r0' : 'ddc:lkg',
    hint: 'structured source failure',
    retryable: true,
    recoveryActions: phase === 'gap' ? ['catalog.reconcile'] : ['run.retry'],
  };
}
