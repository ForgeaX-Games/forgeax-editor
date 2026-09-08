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

  it('keeps the newest handler when overlapping registrations tear down out of order', () => {
    let liveCalls = 0;
    let staleCalls = 0;
    const releaseLive = registerActivePageSaveHandler(() => {
      liveCalls += 1;
      return true;
    });
    const releaseStale = registerActivePageSaveHandler(() => {
      staleCalls += 1;
      return true;
    });
    releaseLive();
    expect(trySaveActivePage()).toBe(true);
    expect(staleCalls).toBe(1);
    expect(liveCalls).toBe(0);
    releaseStale();
    expect(trySaveActivePage()).toBe(false);
  });
});
