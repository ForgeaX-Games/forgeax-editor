/**
 * Regression coverage for useNumberDraft (Inspector "can't type a decimal
 * point" fix). Exercises the exact failure mode reported — typing "." into a
 * number field — plus the risk items flagged during expert review:
 *  - Escape must NOT commit the in-progress draft (React batching race).
 *  - Enter / blur commit the parsed value exactly once.
 *  - ArrowUp/ArrowDown step compensates for the lost native spin behavior.
 *  - Remounting under a new identity (key change on entity/field switch)
 *    must not leak a stale draft into the new instance.
 *
 * No @testing-library/react in this repo yet — component is mounted with a
 * real ReactDOM root over happy-dom, and events are dispatched the same way
 * fireEvent does under the hood (native value-setter + a bubbling Event).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useNumberDraft } from '../useNumberDraft';
import type { FieldSchema } from '@forgeax/editor-core';

function NumberField({ value, fs, onCommit }: { value: number; fs?: FieldSchema | undefined; onCommit: (n: number) => void }) {
  const d = useNumberDraft(value, fs, onCommit);
  return (
    <input
      data-testid="num"
      type="text"
      inputMode="decimal"
      value={d.value}
      onFocus={d.onFocus}
      onChange={d.onChange}
      onBlur={d.onBlur}
      onKeyDown={d.onKeyDown}
    />
  );
}

// Wires onCommit back into a local `value` so chained interactions (e.g. two
// ArrowUp presses in a row) see the same re-render loop the real Inspector
// gives NumberScrubField/NumberDraftInput via gateway.dispatch → new props.
function Host({ initial, fs, onCommit }: { initial: number; fs?: FieldSchema | undefined; onCommit: (n: number) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <NumberField
      value={value}
      fs={fs}
      onCommit={(n) => {
        setValue(n);
        onCommit(n);
      }}
    />
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function input(): HTMLInputElement {
  return container.querySelector('[data-testid="num"]') as HTMLInputElement;
}

// Mirrors @testing-library/react's fireEvent.change: writes through the
// native value setter (bypassing React's tracked-value shortcut) then fires
// a bubbling "input" event so React's onChange fires with the new value.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
function typeValue(el: HTMLInputElement, next: string) {
  act(() => {
    nativeInputValueSetter.call(el, next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(el: HTMLInputElement, key: string, mods: Partial<KeyboardEventInit> = {}) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }));
  });
}

describe('useNumberDraft', () => {
  it('keeps a trailing decimal point in the draft instead of eating it (the original bug)', () => {
    let committed: number | null = null;
    act(() => {
      root.render(<NumberField value={12} onCommit={(n) => { committed = n; }} />);
    });
    const el = input();
    act(() => { el.focus(); });
    typeValue(el, '12.');
    // Bug was: onChange immediately re-derived Number("12.") = 12 and
    // committed, so the controlled value snapped back to "12" and the "."
    // visually vanished. Assert the "." survives while still focused/typing.
    expect(el.value).toBe('12.');
    expect(committed).toBeNull(); // no commit while typing — only on blur/Enter
  });

  it('commits the parsed float on blur', () => {
    let committed: number | null = null;
    act(() => {
      root.render(<NumberField value={12} onCommit={(n) => { committed = n; }} />);
    });
    const el = input();
    act(() => { el.focus(); });
    typeValue(el, '12.5');
    act(() => { el.blur(); });
    expect(committed).toBeCloseTo(12.5, 5);
  });

  it('commits the parsed float on Enter (via blur)', () => {
    let committed: number | null = null;
    act(() => {
      root.render(<NumberField value={0} onCommit={(n) => { committed = n; }} />);
    });
    const el = input();
    act(() => { el.focus(); });
    typeValue(el, '-3.25');
    press(el, 'Enter');
    expect(committed).toBeCloseTo(-3.25, 5);
  });

  it('Escape discards the draft WITHOUT committing (the batching-race risk flagged in review)', () => {
    let committed: number | null = null;
    act(() => {
      root.render(<NumberField value={7} onCommit={(n) => { committed = n; }} />);
    });
    const el = input();
    act(() => { el.focus(); });
    typeValue(el, '999');
    press(el, 'Escape');
    // The dangerous version of this fix (setDraft(null) then synchronously
    // .blur()) reads the OLD `draft` closure inside onBlur and commits "999"
    // anyway. If this hook ever regresses to that shape, this assertion
    // catches it.
    expect(committed).toBeNull();
    expect(el.value).toBe('7');
  });

  it('does not commit an unparsable draft (bare "-" or "." left on blur)', () => {
    let committed: number | null = null;
    act(() => {
      root.render(<NumberField value={5} onCommit={(n) => { committed = n; }} />);
    });
    const el = input();
    act(() => { el.focus(); });
    typeValue(el, '-');
    act(() => { el.blur(); });
    expect(committed).toBeNull();
    expect(el.value).toBe('5'); // rolled back to the last committed value
  });

  it('rejects non-numeric characters at the onChange boundary (draft never adopts garbage)', () => {
    act(() => {
      root.render(<NumberField value={1} onCommit={() => {}} />);
    });
    const el = input();
    act(() => { el.focus(); });
    typeValue(el, '12a');
    // regex rejects "12a" outright -> draft stays whatever it was ("1", the
    // focus-seeded display value), never adopts the invalid string.
    expect(el.value).toBe('1');
  });

  it('ArrowUp/ArrowDown commit immediately using the field step (compensates for the lost native spinner)', () => {
    const commits: number[] = [];
    const fs: FieldSchema = { key: 'x', type: 'number', step: 0.5 };
    act(() => {
      root.render(<NumberField value={1} fs={fs} onCommit={(n) => commits.push(n)} />);
    });
    const el = input();
    act(() => { el.focus(); });
    press(el, 'ArrowUp');
    expect(commits[commits.length - 1]).toBeCloseTo(1.5, 5);
  });

  it('Shift+ArrowUp steps 10x, Alt+ArrowDown steps 0.1x', () => {
    const commits: number[] = [];
    const fs: FieldSchema = { key: 'x', type: 'number', step: 1 };
    act(() => {
      root.render(<Host initial={10} fs={fs} onCommit={(n) => commits.push(n)} />);
    });
    const el = input();
    act(() => { el.focus(); });
    press(el, 'ArrowUp', { shiftKey: true });
    expect(commits[0]).toBeCloseTo(20, 5);
    // Re-render already happened (Host fed the commit back into `value`);
    // second press continues from 20, not the original 10.
    press(el, 'ArrowDown', { altKey: true });
    expect(commits[1]).toBeCloseTo(19.9, 5);
  });

  it('clamps committed values to fs.min/fs.max', () => {
    let committed: number | null = null;
    const fs: FieldSchema = { key: 'x', type: 'number', min: 0, max: 10 };
    act(() => {
      root.render(<NumberField value={5} fs={fs} onCommit={(n) => { committed = n; }} />);
    });
    const el = input();
    act(() => { el.focus(); });
    typeValue(el, '999');
    act(() => { el.blur(); });
    // repo convention (forgeax-editor-harness feedback 2026-07-03): float
    // assertions use toBeCloseTo, not toBe.
    expect(committed).toBeCloseTo(10, 5);
  });

  it('remounting under a fresh key (entity/field switch) does not leak the previous draft', () => {
    let committedA: number | null = null;
    let committedB: number | null = null;
    act(() => {
      root.render(<NumberField key="entA:pos-0" value={1} onCommit={(n) => { committedA = n; }} />);
    });
    const el1 = input();
    act(() => { el1.focus(); });
    typeValue(el1, '1.'); // in-progress, unflushed draft on "entity A"

    // Simulate a non-mouse selection switch (AI/script driven setSelection):
    // no blur happens, but the caller's `key` changes → React unmounts the
    // old instance (dropping its draft state) and mounts a fresh one.
    act(() => {
      root.render(<NumberField key="entB:pos-0" value={42} onCommit={(n) => { committedB = n; }} />);
    });
    const el2 = input();
    expect(el2.value).toBe('42'); // shows entity B's value, not leaked "1."
    act(() => { el2.blur(); });
    expect(committedA).toBeNull(); // entity A's in-progress edit was discarded, not committed
    expect(committedB).toBeNull(); // blurring an untouched field commits nothing
  });
});
