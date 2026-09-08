import { describe, expect, it } from 'bun:test';
import {
  assertOperationsPageReadOnly,
  OPERATIONS_PAGE_READONLY_CONTROLS,
} from '../operations-projection';

describe('Operations Page read-only reverse gate', () => {
  it('exposes only observer controls and never authority controls', () => {
    expect(OPERATIONS_PAGE_READONLY_CONTROLS).toEqual(['open-resource']);
    expect(assertOperationsPageReadOnly(OPERATIONS_PAGE_READONLY_CONTROLS)).toEqual({ ok: true });
  });

  it('rejects injected cancel, retry, undo, and Project-write controls', () => {
    for (const control of ['cancel', 'retry', 'undo', 'write-project', 'dispatch-gateway'] as const) {
      expect(assertOperationsPageReadOnly([control])).toMatchObject({
        ok: false,
        code: 'operations-page-authority-control',
      });
    }
  });
});
