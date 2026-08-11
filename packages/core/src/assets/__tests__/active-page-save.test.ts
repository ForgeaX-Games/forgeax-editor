import { describe, expect, it } from 'bun:test';
import {
  registerActivePageSaveHandler,
  trySaveActivePage,
} from '../active-page-save';

describe('active page save seam', () => {
  it('routes button and shortcut requests through the same live host handler', () => {
    let calls = 0;
    const release = registerActivePageSaveHandler(() => {
      calls += 1;
      return true;
    });

    expect(trySaveActivePage()).toBe(true);
    release();
    expect(trySaveActivePage()).toBe(false);
    expect(calls).toBe(1);
  });
});
