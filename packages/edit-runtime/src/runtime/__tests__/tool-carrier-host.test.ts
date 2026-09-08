import { describe, expect, it } from 'bun:test';
import type { CarrierOffer, ToolTerminal } from '@forgeax/engine-tool-runtime';
import { createToolCarrierHost } from '../tool-carrier-host';

describe('Editor Node host carrier offer', () => {
  it('fails closed when the host has no authenticated ephemeral offer', async () => {
    const host = createToolCarrierHost({ fetch: async () => new Response(JSON.stringify({ ok: false, error: { code: 'carrier-unavailable', hint: 'none' } }), { status: 200 }) });
    await expect(host.offer({ descriptorDigest: 'sha256:d', recipeDigest: 'sha256:r' })).resolves.toMatchObject({ ok: false, error: { code: 'carrier-unavailable' } });
  });

  it('passes Engine auth and state through a disposable provider projection', async () => {
    const calls: Array<{ path: string; authorization?: string; body: Record<string, unknown> }> = [];
    const offer: CarrierOffer = { schemaVersion: '1.0.0', projectId: 'project-1', consumerId: 'editor', offerId: 'offer-1', endpoint: 'http://127.0.0.1:9999/carrier', bearerToken: 'bearer-token-1', livenessToken: 'liveness-token-1', expiresAt: Date.now() + 10_000, descriptorDigest: 'sha256:d', recipeDigest: 'sha256:r', state: 'offered' };
    const host = createToolCarrierHost({ fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ path: String(input), authorization: headers.get('authorization') ?? undefined, body });
      if (String(input) === '/api/carrier/offer') return new Response(JSON.stringify({ ok: true, offer }));
      const path = String(input);
      if (path.endsWith('/start')) return new Response(JSON.stringify({ ok: true, value: { state: 'started', leaseId: 'lease-1' }, state: 'started' }));
      if (path.endsWith('/execute')) {
        const terminal: ToolTerminal<unknown> = { outcome: 'succeeded', result: { ok: true }, artifacts: [] };
        return new Response(JSON.stringify({ ok: true, value: terminal, state: 'started' }));
      }
      if (path.endsWith('/exit')) return new Response(JSON.stringify({ ok: true, value: { state: 'exited', leaseId: 'lease-1' }, state: 'exited' }));
      return new Response(JSON.stringify({ ok: true, value: { leaseId: 'lease-1', offerId: 'offer-1', consumerId: 'editor', state: 'leased' }, state: 'leased' }));
    } });
    const result = await host.offer({ descriptorDigest: 'sha256:d', recipeDigest: 'sha256:r' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await result.provider.execute({ leaseId: 'lease-1', descriptorDigest: 'sha256:d', recipeDigest: 'sha256:r', args: {} })).toMatchObject({ ok: false, error: { code: 'carrier-lease-required' } });
    const lease = await result.provider.lease({ consumerId: 'editor', bearerToken: 'ignored-by-provider', now: 5, descriptorDigest: 'sha256:d', recipeDigest: 'sha256:r' });
    expect(lease.ok).toBe(true);
    expect(calls[0]).toMatchObject({ path: '/api/carrier/offer', authorization: undefined, body: { descriptorDigest: 'sha256:d', recipeDigest: 'sha256:r' } });
    expect(calls[1]).toMatchObject({ authorization: 'Bearer bearer-token-1', body: { bearerToken: 'bearer-token-1', descriptorDigest: 'sha256:d', recipeDigest: 'sha256:r' } });
    expect(await result.provider.started({ leaseId: 'lease-1' })).toMatchObject({ ok: true, state: 'started' });
    expect(await result.provider.execute({ leaseId: 'lease-1', descriptorDigest: 'sha256:d', recipeDigest: 'sha256:r', args: {} })).toMatchObject({ ok: true, state: 'started' });
    expect(await result.provider.exit({ leaseId: 'lease-1' })).toMatchObject({ ok: true, state: 'exited' });
    result.provider.close();
    expect((await result.provider.lease({ consumerId: 'editor', bearerToken: 'ignored-by-provider', now: 6 })).ok).toBe(false);
  });
});
