import type { CommandError } from '../types';

export type GatewayWritePhase = 'open' | 'play' | 'scan' | 'staging' | 'transition' | 'frozen';
export type GatewayWriteKind = 'document' | 'session' | 'scan' | 'version-control' | 'transient';

const gatewayBarriers = new WeakMap<object, GatewayWriteBarrier>();

export function registerGatewayWriteBarrier(owner: object, barrier: GatewayWriteBarrier): void {
  gatewayBarriers.set(owner, barrier);
}

/** Return the one barrier registered for a live Gateway owner. */
export function getGatewayWriteBarrier(owner: object): GatewayWriteBarrier | undefined {
  return gatewayBarriers.get(owner);
}

export function acquireGatewayWrite(owner: object, kind: GatewayWriteKind): GatewayWriteAcquireResult {
  const barrier = gatewayBarriers.get(owner);
  if (barrier === undefined) {
    return {
      ok: false,
      error: {
        code: 'version-control-unavailable',
        hint: 'The Gateway write barrier is not initialized.',
      },
    };
  }
  return barrier.acquire(kind);
}

export interface GatewayWriteLease {
  readonly kind: GatewayWriteKind;
  readonly release: () => void;
}

export type GatewayWriteAcquireResult =
  | { readonly ok: true; readonly lease: GatewayWriteLease }
  | { readonly ok: false; readonly error: CommandError };

export interface GatewayWriteBarrierSnapshot {
  readonly phase: GatewayWritePhase;
  readonly activeWriters: number;
  readonly frozenReason?: string;
}

const failure = (code: CommandError['code'], hint: string): GatewayWriteAcquireResult => ({
  ok: false,
  error: {
    code,
    hint,
    retryable: true,
    recoveryActions: ['version-control.refresh', 'run.wait', 'run.retry'],
  },
});

/** One shared write gate for scan, save, and version-control transitions. */
export class GatewayWriteBarrier {
  private phase: GatewayWritePhase;
  private activeWriters: number;
  private frozenReason: string | undefined;

  constructor() {
    this.phase = 'open';
    this.activeWriters = 0;
  }

  snapshot(): GatewayWriteBarrierSnapshot {
    return Object.freeze({
      phase: this.phase,
      activeWriters: this.activeWriters,
      ...(this.frozenReason === undefined ? {} : { frozenReason: this.frozenReason }),
    });
  }

  acquire(kind: GatewayWriteKind): GatewayWriteAcquireResult {
    if (kind === 'transient') {
      return { ok: true, lease: this.lease(kind) };
    }
    if (this.phase === 'play') return failure('edit-rejected-in-play', 'Stop Play before mutating authored state.');
    if (this.phase === 'scan') return failure('scan-in-progress', 'Wait for the Runtime asset scan to finish.');
    if (this.phase === 'staging') return failure('version-control-staging-active', 'Wait for the current save staging operation to finish.');
    if (this.phase === 'transition') return failure('version-control-transition-active', 'Wait for the current Runtime transition to finish.');
    if (this.phase === 'frozen') return failure('version-control-external-inspection-required', this.frozenReason ?? 'Inspect the repository before continuing.');
    if (this.activeWriters > 0) return failure('version-control-operation-busy', 'Another Gateway write operation is running.');
    return { ok: true, lease: this.lease(kind) };
  }

  enterPlay(): void { this.phase = 'play'; }
  exitPlay(): void { if (this.phase === 'play') this.phase = 'open'; }
  beginScan(): void { if (this.phase === 'open') this.phase = 'scan'; }
  endScan(): void { if (this.phase === 'scan') this.phase = 'open'; }
  beginStaging(): void { if (this.phase === 'open') this.phase = 'staging'; }
  endStaging(): void { if (this.phase === 'staging') this.phase = 'open'; }
  beginTransition(): void { if (this.phase === 'open') this.phase = 'transition'; }
  endTransition(): void { if (this.phase === 'transition') this.phase = 'open'; }
  freeze(reason = 'external-inspection-required'): void {
    this.phase = 'frozen';
    this.frozenReason = reason;
  }
  releaseFreeze(): void {
    this.frozenReason = undefined;
    this.phase = 'open';
  }

  private lease(kind: GatewayWriteKind): GatewayWriteLease {
    this.activeWriters += 1;
    let released = false;
    return {
      kind,
      release: () => {
        if (released) return;
        released = true;
        this.activeWriters = Math.max(0, this.activeWriters - 1);
      },
    };
  }
}
