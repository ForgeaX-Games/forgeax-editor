// M6 RED contract: renderer owner admission is one identity-bound lifecycle
// lease. The implementation arrives in m6-t08-a; this file intentionally
// imports that not-yet-present seam.

import { describe, expect, it } from 'bun:test';
import type {
  RendererOwnerAdmissionIdentity,
  RendererOwnerAdmissionRequest,
} from '@forgeax/editor-product';
import { createRendererOwnerAdmissionLease } from '../renderer-owner-admission';

const identity: RendererOwnerAdmissionIdentity = {
  carrierId: 'carrier-gta-route-dev',
  pageIdentity: 'http://localhost:18920/editor',
  browserRealmId: 'realm-1',
  runtimeId: 'runtime-1',
  canvasIdentity: 'canvas-1',
  rendererGeneration: 'renderer-generation-1',
};

const request = (
  overrides: Partial<RendererOwnerAdmissionRequest> = {},
): RendererOwnerAdmissionRequest => ({
  schema: 'renderer-owner-admission/v1',
  operation: 'renderer.ownerAdmission',
  shadowSubmitMode: 'coalesced-with-frame',
  identity,
  ...overrides,
});

type RestoreReason =
  | 'finally'
  | 'stop'
  | 'unmount'
  | 'dispose'
  | 'generation-change';

interface RendererOwnerAdmissionLeaseUnderTest {
  applyAtFrameBoundary(input: RendererOwnerAdmissionRequest): {
    ok: boolean;
    error?: { code: string };
  };
  restoreOnce(reason: RestoreReason): void;
  clearForDispose(): void;
  clearForGeneration(identity: RendererOwnerAdmissionIdentity): void;
}

interface LeaseDepsUnderTest {
  identity: RendererOwnerAdmissionIdentity;
  readRendererGeneration(): string;
  apply(input: RendererOwnerAdmissionRequest): void;
  restore(): void;
}

const createLease = createRendererOwnerAdmissionLease as unknown as (
  deps: LeaseDepsUnderTest,
) => RendererOwnerAdmissionLeaseUnderTest;

function createFixture() {
  let rendererGeneration = identity.rendererGeneration;
  let appliedCount = 0;
  let restoredCount = 0;
  const applied: RendererOwnerAdmissionRequest[] = [];

  const lease = createLease({
    identity,
    readRendererGeneration: () => rendererGeneration,
    apply(input) {
      appliedCount += 1;
      applied.push(input);
    },
    restore() {
      restoredCount += 1;
    },
  });

  return {
    lease,
    applied,
    get appliedCount() {
      return appliedCount;
    },
    get restoredCount() {
      return restoredCount;
    },
    setRendererGeneration(value: string) {
      rendererGeneration = value;
    },
  };
}

describe('renderer owner admission lifecycle lease', () => {
  it('applies once at the frame boundary and rejects renderer-generation drift', () => {
    const fixture = createFixture();

    expect(fixture.lease.applyAtFrameBoundary(request())).toEqual({ ok: true });
    expect(fixture.lease.applyAtFrameBoundary(request())).toEqual({ ok: true });
    expect(fixture.appliedCount).toBe(1);
    expect(fixture.applied[0]?.identity).toEqual(identity);

    fixture.setRendererGeneration('renderer-generation-2');
    const stale = fixture.lease.applyAtFrameBoundary(request());
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe(
      'renderer-owner-admission-generation-mismatch',
    );
    expect(fixture.appliedCount).toBe(1);
  });

  it('shares one physical restore between finally, Stop, and unmount duplicates', () => {
    const fixture = createFixture();
    expect(fixture.lease.applyAtFrameBoundary(request())).toEqual({ ok: true });

    fixture.lease.restoreOnce('finally');
    fixture.lease.restoreOnce('stop');
    fixture.lease.restoreOnce('unmount');
    fixture.lease.restoreOnce('stop');

    expect(fixture.restoredCount).toBe(1);
  });

  it('clears the lease on dispose and renderer-generation change before reuse', () => {
    const fixture = createFixture();
    expect(fixture.lease.applyAtFrameBoundary(request())).toEqual({ ok: true });
    fixture.lease.clearForDispose();
    fixture.lease.restoreOnce('dispose');
    expect(fixture.restoredCount).toBe(1);
    expect(fixture.lease.applyAtFrameBoundary(request()).ok).toBe(false);
    expect(fixture.appliedCount).toBe(1);

    const nextFixture = createFixture();
    nextFixture.setRendererGeneration('renderer-generation-2');
    const nextIdentity = {
      ...identity,
      rendererGeneration: 'renderer-generation-2',
    };
    nextFixture.lease.clearForGeneration(nextIdentity);
    expect(
      nextFixture.lease.applyAtFrameBoundary(
        request({ identity: nextIdentity }),
      ),
    ).toEqual({ ok: true });
    expect(nextFixture.appliedCount).toBe(1);
    nextFixture.lease.restoreOnce('generation-change');
    expect(nextFixture.restoredCount).toBe(1);
  });
});
