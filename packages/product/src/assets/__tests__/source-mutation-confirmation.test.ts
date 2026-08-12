import { describe, expect, test } from 'bun:test';
import {
  authorizeAssetSourceMutation,
  preflightAssetSourceMutation,
  type AssetSourceMutationSnapshot,
} from '../preflight';

function snapshot(): AssetSourceMutationSnapshot {
  return {
    metaRevision: 'meta:r7',
    outputs: [
      {
        guid: 'guid:mesh',
        sourceKey: 'source:mesh',
        referencerGuids: ['guid:scene'],
        instanceGuids: ['instance:scene'],
      },
      {
        guid: 'guid:material',
        sourceKey: 'source:material',
        referencerGuids: ['guid:scene'],
        instanceGuids: ['instance:scene'],
      },
    ],
  };
}

function discardPreflight() {
  return preflightAssetSourceMutation(
    snapshot(),
    { guid: 'guid:mesh', scope: { sourceKey: 'source:mesh' } },
    { now: 1_000, confirmationTtlMs: 100 },
  );
}

describe('source mutation confirmation', () => {
  test('binds discard confirmation to scope, impact, and Meta revision', () => {
    const result = discardPreflight();

    expect(result.confirmation.required).toBe(true);
    expect(result.confirmation.token).toMatch(/^asset-source-confirmation:/);
    expect(result.confirmation.scope).toEqual({ sourceKey: 'source:mesh' });
    expect(result.confirmation.expectedRevision).toBe('meta:r7');
    expect(result.confirmation.affectedGuids).toEqual(['guid:mesh']);
  });

  test('rejects missing, expired, and mismatched discard confirmation', () => {
    const result = discardPreflight();
    const missing = authorizeAssetSourceMutation(result, {
      intent: 'discard-source-overrides-and-reimport',
      now: 1_010,
    });
    const expired = authorizeAssetSourceMutation(result, {
      intent: 'discard-source-overrides-and-reimport',
      confirmationToken: result.confirmation.token,
      now: 1_101,
    });
    const otherScope = preflightAssetSourceMutation(
      snapshot(),
      { guid: 'guid:mesh', scope: { all: true } },
      { now: 1_000, confirmationTtlMs: 100 },
    );
    const mismatched = authorizeAssetSourceMutation(result, {
      intent: 'discard-source-overrides-and-reimport',
      confirmationToken: otherScope.confirmation.token,
      now: 1_010,
    });

    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe('asset-confirmation-required');
    expect(expired.ok).toBe(false);
    expect(expired.error?.code).toBe('asset-confirmation-expired');
    expect(mismatched.ok).toBe(false);
    expect(mismatched.error?.code).toBe('asset-confirmation-mismatch');
  });

  test('does not require destructive confirmation for save or ordinary reimport', () => {
    const preflight = discardPreflight();

    for (const intent of ['save-asset-source-override', 'reimport-asset'] as const) {
      const result = authorizeAssetSourceMutation(preflight, { intent, now: 1_010 });
      expect(result.ok).toBe(true);
      expect(result.confirmationRequired).toBe(false);
    }
  });
});
