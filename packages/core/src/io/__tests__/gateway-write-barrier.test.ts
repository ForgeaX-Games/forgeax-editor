import { describe, expect, test } from 'bun:test';
import { GatewayWriteBarrier, acquireGatewayWrite, getGatewayWriteBarrier, registerGatewayWriteBarrier } from '../gateway-write-barrier';

describe('GatewayWriteBarrier', () => {
  test('rejects authored writes while Play owns the world but leaves transient writes available', () => {
    const barrier = new GatewayWriteBarrier();
    barrier.enterPlay();

    expect(barrier.acquire('version-control')).toMatchObject({
      ok: false,
      error: { code: 'edit-rejected-in-play' },
    });
    expect(barrier.acquire('scan')).toMatchObject({
      ok: false,
      error: { code: 'edit-rejected-in-play' },
    });
    expect(barrier.acquire('transient').ok).toBe(true);
    barrier.exitPlay();
  });

  test('serializes concurrent mutation and exposes transition/freeze release', () => {
    const barrier = new GatewayWriteBarrier();
    const first = barrier.acquire('version-control');
    expect(first.ok).toBe(true);
    expect(barrier.acquire('version-control')).toMatchObject({
      ok: false,
      error: { code: 'version-control-operation-busy' },
    });
    if (first.ok) first.lease.release();

    barrier.beginTransition();
    expect(barrier.acquire('version-control')).toMatchObject({
      ok: false,
      error: { code: 'version-control-transition-active' },
    });
    barrier.freeze('external-inspection-required');
    expect(barrier.acquire('version-control')).toMatchObject({
      ok: false,
      error: { code: 'version-control-external-inspection-required' },
    });
    barrier.releaseFreeze();
    barrier.endTransition();
    const lease = barrier.acquire('version-control');
    expect(lease.ok).toBe(true);
  });

  test('staging is shared by save and version-control without becoming a ledger operation', () => {
    const barrier = new GatewayWriteBarrier();
    barrier.beginStaging();
    expect(barrier.acquire('version-control')).toMatchObject({
      ok: false,
      error: { code: 'version-control-staging-active' },
    });
    const transient = barrier.acquire('transient');
    expect(transient.ok).toBe(true);
    if (transient.ok) transient.lease.release();
    barrier.endStaging();
    expect(barrier.acquire('version-control').ok).toBe(true);
  });

  test('scan uses the same gate as version-control mutation', () => {
    const barrier = new GatewayWriteBarrier();
    barrier.beginScan();
    expect(barrier.acquire('version-control')).toMatchObject({ ok: false, error: { code: 'scan-in-progress' } });
    barrier.endScan();
    expect(barrier.acquire('version-control').ok).toBe(true);
  });

  test('exposes the registered owner and fails closed when no owner is registered', () => {
    const owner = {};
    expect(getGatewayWriteBarrier(owner)).toBeUndefined();
    expect(acquireGatewayWrite(owner, 'version-control')).toMatchObject({
      ok: false,
      error: { code: 'version-control-unavailable' },
    });
    const barrier = new GatewayWriteBarrier();
    registerGatewayWriteBarrier(owner, barrier);
    expect(getGatewayWriteBarrier(owner)).toBe(barrier);
    const lease = acquireGatewayWrite(owner, 'version-control');
    expect(lease.ok).toBe(true);
    if (lease.ok) {
      lease.lease.release();
      lease.lease.release();
    }
    expect(barrier.snapshot()).toMatchObject({ phase: 'open', activeWriters: 0 });
  });

  test('covers no-op lifecycle calls when the barrier is already open', () => {
    const barrier = new GatewayWriteBarrier();
    barrier.exitPlay();
    barrier.endScan();
    barrier.endStaging();
    barrier.endTransition();
    barrier.releaseFreeze();
    expect(barrier.snapshot()).toMatchObject({ phase: 'open', activeWriters: 0 });
  });
});
