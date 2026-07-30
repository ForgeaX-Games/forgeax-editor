import { describe, expect, test } from 'bun:test';
import { runProductWorkspaceHeadless } from '../../../../scripts/product-conformance';

describe('headless workspace reconciliation', () => {
  test('settles an external change without React, Content Browser, refresh, or Chromium', () => {
    const result = runProductWorkspaceHeadless();

    expect(result.ok).toBe(true);
    expect(result.revision).toBe('workspace:r1');
    expect(result.snapshot.subjects).toHaveLength(1);
    expect(result.snapshot.identity).toBe(result.repeatedSnapshot.identity);
    expect(result.repeatedSnapshot.revision).toBe(result.snapshot.revision);
  });
});
