import { describe, expect, it } from 'bun:test';
import { EditGateway } from '../io/gateway';

describe('imported source authoring availability boundary', () => {
  it('keeps operations discoverable but rejects them before run or world mutation', () => {
    const gateway = new EditGateway();
    const beforeWorld = gateway.doc.world;
    const beforeRevision = gateway.rev;
    const beforeLedger = gateway.ledger.length;

    const ids = gateway.listOps().map((op) => op.id);
    expect(ids).not.toEqual(expect.arrayContaining(['editImportedSource', 'saveImportedSource']));

    expect(gateway.dispatch({
      kind: 'saveAssetSourceOverride',
      guid: '11111111-1111-4111-8111-111111111111',
      scope: { sourceKey: 'scene:main' },
      expectedRevision: 'ddc:r1',
      requestId: 'source-edit-unavailable',
    }, 'ai')).toMatchObject({
      ok: false,
      error: {
        code: expect.stringMatching(/UNKNOWN_OP|unavailable|source-authoring/),
      },
    });

    expect(gateway.dispatch({
      kind: 'discardSourceOverridesAndReimport',
      guid: '11111111-1111-4111-8111-111111111111',
      scope: { all: true },
      expectedRevision: 'ddc:r1',
      confirmationToken: 'source-confirmation-red',
      requestId: 'source-save-unavailable',
    }, 'human')).toMatchObject({
      ok: false,
      error: {
        code: expect.stringMatching(/UNKNOWN_OP|unavailable|source-authoring/),
      },
    });

    expect(gateway.doc.world).toBe(beforeWorld);
    expect(gateway.rev).toBe(beforeRevision);
    expect(gateway.ledger).toHaveLength(beforeLedger);
    expect(gateway.getOperationRun('source-edit-unavailable')).toBeUndefined();
    expect(gateway.getOperationRun('source-save-unavailable')).toBeUndefined();
  });
});
