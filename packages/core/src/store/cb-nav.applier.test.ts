// cb-nav applier unit tests — M3 t11
//
// Covers requirements AC-1.1 through AC-1.6 (applier behaviour):
//   AC-1.1: normal navigate — path updates, canGoBack=true, ledger grows +1
//   AC-1.2: dedup — duplicate dispatches do NOT grow history stack,
//             BUT ledger grows ×3 (intent-stream full-record, D-2)
//   AC-1.3: tail truncation — dispatching new path after goBack
//             discards all forward entries
//   AC-1.4: cbGoBack no-op at index=0 — path unchanged, ledger still grows
//   AC-1.5: cbGoForward no-op at end — symmetric to AC-1.4
//   AC-1.6: goBack → goForward round-trip — final path equals start
//
// ── Isolation strategy ────────────────────────────────────────────────────
// cb-nav.ts stores history/index as module-level state shared across all tests.
// Each test creates a fresh EditGateway (→ fresh ledger) and calls resetToAnchor()
// which: (a) goes back 60× to reach index=0, (b) navigates to a per-test anchor
// path that truncates any forward entries.  Assertions are relative to the anchor.
//
// Importing from './cb-nav' triggers the sessionAppliers.set() side effects.

import { describe, expect, it, beforeEach } from 'bun:test';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import { getCBPath, getCBNavState } from './cb-nav';

function makeGW(): EditGateway {
  return new EditGateway(createEditSession());
}

// Drive navigation back to index=0, then navigate to anchor path.
// 60 no-op cbGoBack calls drain any accumulated history.
// The anchor setCBPath truncates any forward entries from that position.
function resetToAnchor(gw: EditGateway, anchor: string): void {
  for (let i = 0; i < 60; i++) {
    gw.dispatch({ kind: 'cbGoBack' });
  }
  gw.dispatch({ kind: 'setCBPath', path: anchor });
}

// ── AC-1.1: setCBPath normal navigate ─────────────────────────────────────
describe('AC-1.1: setCBPath normal navigate', () => {
  let gw: EditGateway;
  const ANCHOR = '__ac11__';

  beforeEach(() => {
    gw = makeGW();
    resetToAnchor(gw, ANCHOR);
  });

  it('dispatching setCBPath updates path, canGoBack becomes true, ledger grows by 1', () => {
    const ledgerBefore = gw.ledger.length;

    const result = gw.dispatch({ kind: 'setCBPath', path: 'a' });
    expect(result.ok).toBe(true);
    expect(getCBPath()).toBe('a');

    const state = getCBNavState();
    expect(state.path).toBe('a');
    expect(state.canGoBack).toBe(true);    // index > 0 after navigate
    expect(state.canGoForward).toBe(false); // no forward entries

    // AC-1.1: ledger appended exactly once
    expect(gw.ledger.length).toBe(ledgerBefore + 1);
    expect((gw.ledger[gw.ledger.length - 1] as { kind: string; path: string }).path).toBe('a');
  });
});

// ── AC-1.2: dedup — duplicate dispatches ──────────────────────────────────
describe('AC-1.2: setCBPath dedup — same-path dispatches', () => {
  let gw: EditGateway;
  const ANCHOR = '__ac12__';

  beforeEach(() => {
    gw = makeGW();
    resetToAnchor(gw, ANCHOR);
    // Establish 'a' as the current path
    gw.dispatch({ kind: 'setCBPath', path: 'a' });
  });

  it('three duplicate dispatches grow ledger ×3 AND leave history stack unchanged', () => {
    const ledgerBefore = gw.ledger.length;

    // Duplicate dispatches — same path 'a' three more times
    gw.dispatch({ kind: 'setCBPath', path: 'a' });
    gw.dispatch({ kind: 'setCBPath', path: 'a' });
    gw.dispatch({ kind: 'setCBPath', path: 'a' });

    // Ledger must grow by 3 (intent stream full-record — AC-1.2, D-2)
    expect(gw.ledger.length).toBe(ledgerBefore + 3);

    // Current path is still 'a' (dedup did not change state)
    expect(getCBPath()).toBe('a');

    // History stack dedup verified behaviourally: exactly 1 goBack exits 'a'
    gw.dispatch({ kind: 'cbGoBack' });
    expect(getCBPath()).toBe(ANCHOR); // only 1 step back to anchor — not 4 steps

    // Forward still works (confirming history is [anchor, 'a'])
    gw.dispatch({ kind: 'cbGoForward' });
    expect(getCBPath()).toBe('a');
  });
});

// ── AC-1.3: tail truncation ───────────────────────────────────────────────
describe('AC-1.3: setCBPath tail-truncates forward entries', () => {
  let gw: EditGateway;
  const ANCHOR = '__ac13__';

  beforeEach(() => {
    gw = makeGW();
    resetToAnchor(gw, ANCHOR);
    // Build: anchor → a → b
    gw.dispatch({ kind: 'setCBPath', path: 'a' });
    gw.dispatch({ kind: 'setCBPath', path: 'b' });
    // Go back to 'a' so 'b' is a forward entry
    gw.dispatch({ kind: 'cbGoBack' });
    expect(getCBNavState().canGoForward).toBe(true); // 'b' is reachable
  });

  it('navigating from mid-stack discards all forward entries', () => {
    // Dispatch 'c' from position 'a' — 'b' must be truncated
    gw.dispatch({ kind: 'setCBPath', path: 'c' });
    expect(getCBPath()).toBe('c');
    expect(getCBNavState().canGoForward).toBe(false); // 'b' is gone

    // Verify stack is: anchor → a → c
    gw.dispatch({ kind: 'cbGoBack' });
    expect(getCBPath()).toBe('a');
    gw.dispatch({ kind: 'cbGoBack' });
    expect(getCBPath()).toBe(ANCHOR);
  });
});

// ── AC-1.4: cbGoBack no-op at start ──────────────────────────────────────
describe('AC-1.4: cbGoBack no-op at index=0', () => {
  let gw: EditGateway;

  beforeEach(() => {
    gw = makeGW();
    // Drive all the way back to index=0
    for (let i = 0; i < 60; i++) {
      gw.dispatch({ kind: 'cbGoBack' });
    }
    expect(getCBNavState().canGoBack).toBe(false);
  });

  it('goBack at start is a no-op: path unchanged, but ledger still appends', () => {
    const pathBefore = getCBPath();
    const ledgerBefore = gw.ledger.length;

    const result = gw.dispatch({ kind: 'cbGoBack' });
    expect(result.ok).toBe(true);
    expect(getCBPath()).toBe(pathBefore);           // path unchanged
    expect(getCBNavState().canGoBack).toBe(false);  // still at start
    expect(gw.ledger.length).toBe(ledgerBefore + 1); // ledger grows regardless (AC-1.4)
  });
});

// ── AC-1.5: cbGoForward no-op at end ─────────────────────────────────────
describe('AC-1.5: cbGoForward no-op at end of history', () => {
  let gw: EditGateway;
  const ANCHOR = '__ac15__';

  beforeEach(() => {
    gw = makeGW();
    resetToAnchor(gw, ANCHOR);
    gw.dispatch({ kind: 'setCBPath', path: 'a' });
    expect(getCBNavState().canGoForward).toBe(false); // at the end
  });

  it('goForward at end is a no-op: path unchanged, but ledger still appends', () => {
    const pathBefore = getCBPath();
    const ledgerBefore = gw.ledger.length;

    const result = gw.dispatch({ kind: 'cbGoForward' });
    expect(result.ok).toBe(true);
    expect(getCBPath()).toBe(pathBefore);             // path unchanged
    expect(getCBNavState().canGoForward).toBe(false); // still at end
    expect(gw.ledger.length).toBe(ledgerBefore + 1);  // ledger grows regardless (AC-1.5)
  });
});

// ── AC-1.6: goBack → goForward round-trip ────────────────────────────────
describe('AC-1.6: goBack → goForward round-trip', () => {
  let gw: EditGateway;
  const ANCHOR = '__ac16__';

  beforeEach(() => {
    gw = makeGW();
    resetToAnchor(gw, ANCHOR);
    gw.dispatch({ kind: 'setCBPath', path: 'a' });
  });

  it('goBack then goForward restores original path', () => {
    const originPath = getCBPath(); // 'a'

    gw.dispatch({ kind: 'cbGoBack' });
    expect(getCBPath()).not.toBe(originPath); // moved away from 'a'

    gw.dispatch({ kind: 'cbGoForward' });
    expect(getCBPath()).toBe(originPath); // back at 'a'
  });
});
