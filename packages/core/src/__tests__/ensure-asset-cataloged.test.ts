import { describe, expect, it } from 'bun:test';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { ensureAssetCataloged } from '../assets/ensure-asset-cataloged';

const GUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

interface FakeRegistry {
  lookupCalls: string[];
  loadCalls: string[];
  lookup(guid: string): unknown;
  loadByGuid(guid: unknown): Promise<{ ok: boolean; value?: unknown }>;
}

function makeRegistry(opts: { cataloged?: boolean; loadOk?: boolean } = {}): FakeRegistry {
  const calls: FakeRegistry = {
    lookupCalls: [],
    loadCalls: [],
    lookup(guid: string) {
      calls.lookupCalls.push(guid);
      return opts.cataloged ? { kind: 'material' } : undefined;
    },
    loadByGuid(guid: unknown) {
      calls.loadCalls.push(String(guid));
      return Promise.resolve(opts.loadOk === false
        ? { ok: false }
        : { ok: true, value: { kind: 'material' } });
    },
  };
  return calls;
}

describe('ensureAssetCataloged', () => {
  it('returns false without a registry (headless / pre-boot)', async () => {
    expect(await ensureAssetCataloged(undefined, GUID)).toBe(false);
  });

  it('short-circuits on an already-cataloged GUID (no fetch)', async () => {
    const reg = makeRegistry({ cataloged: true });
    expect(await ensureAssetCataloged(reg as never, GUID)).toBe(true);
    expect(reg.lookupCalls).toEqual([GUID]);
    expect(reg.loadCalls).toEqual([]);
  });

  it('loadByGuid populates the envelope on a catalog miss', async () => {
    const reg = makeRegistry();
    expect(await ensureAssetCataloged(reg as never, GUID)).toBe(true);
    expect(reg.loadCalls).toHaveLength(1);
  });

  it('passes a parsed AssetGuid (not the raw string) to loadByGuid', async () => {
    let received: unknown;
    const reg = makeRegistry();
    reg.loadByGuid = (guid: unknown) => { received = guid; return Promise.resolve({ ok: true, value: {} }); };
    await ensureAssetCataloged(reg as never, GUID.toUpperCase());
    // A branded AssetGuid formats back to the canonical lowercase dash form —
    // proving the helper parsed (and case-normalized) rather than passing the
    // raw caller string through.
    expect(typeof received).not.toBe('string');
    expect(AssetGuid.format(received as AssetGuid)).toBe(GUID.toLowerCase());
  });

  it('returns false for a malformed GUID without calling loadByGuid', async () => {
    const reg = makeRegistry();
    expect(await ensureAssetCataloged(reg as never, 'not-a-guid')).toBe(false);
    expect(reg.loadCalls).toEqual([]);
  });

  it('returns false when the load fails (caller keeps snapshot fallback)', async () => {
    const reg = makeRegistry({ loadOk: false });
    expect(await ensureAssetCataloged(reg as never, GUID)).toBe(false);
  });

  it('returns false when loadByGuid rejects (transport error)', async () => {
    const reg = makeRegistry();
    reg.loadByGuid = () => Promise.reject(new Error('network'));
    expect(await ensureAssetCataloged(reg as never, GUID)).toBe(false);
  });
});
