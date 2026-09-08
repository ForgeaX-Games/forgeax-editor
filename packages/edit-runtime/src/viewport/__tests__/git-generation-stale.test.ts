import { describe, expect, test } from 'bun:test';
import {
  createGenerationFence,
  createStaleGenerationError,
} from '../ViewportComponent';
import { createViewportGenerationLease } from '../../runtime/ViewportRuntimeFrame';

describe('generation-fenced viewport projections', () => {
  test('invalidates every old reference after a generation increment', () => {
    const fence = createGenerationFence(3);
    const old = fence.capture();
    expect(fence.assert(old)).toEqual({ ok: true, generation: 3 });
    const next = fence.advance();
    expect(next).toBe(4);
    const stale = fence.assert(old);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toMatchObject({ code: 'version-control-stale-generation', expected: 4, actual: 3 });
    expect(createStaleGenerationError(3, 4).code).toBe('version-control-stale-generation');
  });

  test('does not expose successor leases before cold-ready', () => {
    const lease = createViewportGenerationLease(11);
    expect(lease.snapshot()).toMatchObject({ generation: 11, state: 'barrier' });
    expect(lease.acceptAction('action-before-ready').ok).toBe(false);
    lease.markColdReady({ projectionLease: 'projection-g12', actionLease: 'action-g12' });
    expect(lease.snapshot()).toMatchObject({ generation: 12, state: 'ready', projectionLease: 'projection-g12', actionLease: 'action-g12' });
    expect(lease.acceptAction('action-g12')).toEqual({ ok: true, generation: 12 });
    expect(lease.acceptAction('action-g11').ok).toBe(false);
  });
});
