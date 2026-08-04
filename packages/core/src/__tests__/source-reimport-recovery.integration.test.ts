import { describe, expect, test } from 'bun:test';
import {
  reduceSourceRecoveryState,
  type SourceRecoveryState,
} from '../session/source-authoring-ops';

describe('source reimport recovery', () => {
  test('keeps Meta and last-known-good publication after a failed rebuild', () => {
    const initial: SourceRecoveryState = {
      metaRevision: 'meta:r7',
      currentRevision: 'ddc:r7',
      lastKnownGoodRevision: 'ddc:r7',
      terminal: 'succeeded',
    };

    const failed = reduceSourceRecoveryState(initial, {
      type: 'reimport-failed',
      metaRevision: 'meta:r8',
      errorCode: 'asset-cook-failed',
    });

    expect(failed).toMatchObject({
      metaRevision: 'meta:r8',
      currentRevision: 'ddc:r7',
      lastKnownGoodRevision: 'ddc:r7',
      terminal: 'failed',
      errorCode: 'asset-cook-failed',
    });
  });
});
