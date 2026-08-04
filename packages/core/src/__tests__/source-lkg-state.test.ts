import { describe, expect, test } from 'bun:test';
import {
  reduceSourceLkgState,
  type SourceLkgState,
} from '../session/source-authoring-ops';

describe('source last-known-good state', () => {
  test('moves current and LKG together only after publication succeeds', () => {
    const initial: SourceLkgState = {
      current: 'ddc:r7',
      lastKnownGood: 'ddc:r7',
      phase: 'current',
    };
    const rebuilding = reduceSourceLkgState(initial, { type: 'rebuild-started', candidate: 'ddc:r8' });
    expect(rebuilding).toEqual({ ...initial, phase: 'rebuilding' });

    const failed = reduceSourceLkgState(rebuilding, { type: 'rebuild-failed', errorCode: 'asset-cook-failed' });
    expect(failed).toMatchObject({ current: 'ddc:r7', lastKnownGood: 'ddc:r7', phase: 'failed' });

    const published = reduceSourceLkgState(rebuilding, { type: 'published', candidate: 'ddc:r8' });
    expect(published).toEqual({ current: 'ddc:r8', lastKnownGood: 'ddc:r8', phase: 'current' });
  });
});
