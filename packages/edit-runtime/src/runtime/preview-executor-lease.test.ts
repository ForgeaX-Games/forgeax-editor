import { describe, expect, test } from 'bun:test';
import type { TransportMessagePort } from '@forgeax/editor-product';
import {
  createPreviewExecutorCarrier,
  createPreviewExecutorClient,
  createPreviewExecutorLeaseIdentity,
  getShellPreviewExecutorLeaseSnapshot,
  installInProcessPreviewExecutorLeaseHost,
  registerShellPreviewExecutorLease,
} from './preview-executor-lease';

class FakePort implements TransportMessagePort {
  peer: FakePort | null = null;
  closed = false;
  private readonly listeners = new Set<(event: { readonly data: unknown }) => void>();

  postMessage(message: unknown): void {
    if (this.closed) return;
    const peer = this.peer;
    queueMicrotask(() => {
      if (peer?.closed) return;
      for (const listener of [...(peer?.listeners ?? [])]) listener({ data: message });
    });
  }

  addEventListener(_type: 'message', listener: (event: { readonly data: unknown }) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: { readonly data: unknown }) => void): void {
    this.listeners.delete(listener);
  }

  close(): void { this.closed = true; }
}

function channel(): readonly [FakePort, FakePort] {
  const first = new FakePort();
  const second = new FakePort();
  first.peer = second;
  second.peer = first;
  return [first, second];
}

describe('preview executor lease', () => {
  test('serializes typed reverse requests and rejects in-flight work on disconnect', async () => {
    const identity = createPreviewExecutorLeaseIdentity('test-preview/v1', 'asset-a', () => 'lease-a');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const lease = {
      identity,
      async execute(command: unknown) {
        if ((command as { kind?: string }).kind === 'blocked') await blocked;
        return { ok: true as const, value: command };
      },
    };
    const [hostPort, runtimePort] = channel();
    const carrier = createPreviewExecutorCarrier(hostPort, lease);
    const client = createPreviewExecutorClient(runtimePort, identity, 1_000);

    await expect(client.execute({ kind: 'play' })).resolves.toEqual({
      ok: true,
      value: { kind: 'play' },
    });
    const inFlight = client.execute({ kind: 'blocked' });
    client.dispose();
    await expect(inFlight).resolves.toMatchObject({
      ok: false,
      error: { code: 'preview-executor-disconnected' },
    });
    release();
    carrier.dispose();
  });

  test('keeps one replaceable Shell owner and never revives an older disposed lease', () => {
    const first = {
      identity: createPreviewExecutorLeaseIdentity('test-preview/v1', 'asset-a', () => 'lease-first'),
      execute: () => ({ ok: true as const, value: 'first' }),
    };
    const second = {
      identity: createPreviewExecutorLeaseIdentity('test-preview/v1', 'asset-b', () => 'lease-second'),
      execute: () => ({ ok: true as const, value: 'second' }),
    };
    const disposeFirst = registerShellPreviewExecutorLease(first);
    const disposeSecond = registerShellPreviewExecutorLease(second);

    disposeFirst();
    expect(getShellPreviewExecutorLeaseSnapshot().lease).toBe(second);
    disposeSecond();
    expect(getShellPreviewExecutorLeaseSnapshot().lease).toBeNull();
  });

  test('binds and releases the same lifecycle in-process', () => {
    const observed: string[] = [];
    const uninstallHost = installInProcessPreviewExecutorLeaseHost((identity) => {
      observed.push(`bind:${identity.leaseId}`);
      return () => observed.push(`unbind:${identity.leaseId}`);
    });
    const lease = {
      identity: createPreviewExecutorLeaseIdentity('test-preview/v1', 'asset-c', () => 'lease-local'),
      execute: () => ({ ok: true as const, value: null }),
    };
    const unregister = registerShellPreviewExecutorLease(lease);
    expect(getShellPreviewExecutorLeaseSnapshot().connected).toBe(true);
    unregister();
    expect(getShellPreviewExecutorLeaseSnapshot().connected).toBe(false);
    uninstallHost();

    expect(observed).toEqual(['bind:lease-local', 'unbind:lease-local']);
  });
});
