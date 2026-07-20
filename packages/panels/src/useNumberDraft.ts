import { useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { clampToField, type FieldSchema } from '@forgeax/editor-core';

// Permissive intermediate typing states — "", "-", ".", "12.", "-0.5" — that a
// user passes through on the way to a finished number. Full validity (NaN
// rejection) is only enforced on commit, not on every keystroke.
const DRAFT_RE = /^-?\d*\.?\d*$/;

export interface NumberDraftHandlers {
  value: string;
  onFocus: () => void;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onBlur: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  // Commit whatever is in-progress right now, for callers that steal control
  // from the text field without a natural blur in between (e.g. scrub drag).
  flush: () => void;
}

// Text-input driver for numeric fields.
//
// A controlled `<input type="number">` can't hold an invalid-but-in-progress
// string like "12." or "-" — the browser blanks `.value` for it — and this
// component used to re-derive + commit a `number` on every keystroke, so the
// blanked value round-tripped straight back into the controlled `value` prop
// and the "." visually vanished. Fix: edit a local string draft and only
// parse + commit on blur/Enter (mirrors NameField's draft/abort pattern).
//
// Callers must give the owning element an identity-bearing `key` (entity id +
// field key) so React remounts — and resets this hook's state — when the
// field's identity changes, instead of leaking a draft across entities.
export function useNumberDraft(display: number, fs: FieldSchema | undefined, onCommit: (n: number) => void): NumberDraftHandlers {
  const [draft, setDraft] = useState<string | null>(null);
  // `abort.current` (not state) matters: Escape needs to suppress the *next*
  // blur commit inside the same synchronous event, before React has re-run
  // this hook with a fresh `draft` closure.
  const abort = useRef(false);
  const arrowStep = fs?.step ?? 1;

  function flush() {
    if (draft === null) return;
    const n = Number(draft);
    if (Number.isFinite(n)) onCommit(clampToField(fs, n));
    setDraft(null);
  }

  return {
    value: draft !== null ? draft : String(display),
    onFocus: () => setDraft(String(display)),
    onChange: (e) => {
      if (DRAFT_RE.test(e.target.value)) setDraft(e.target.value);
    },
    onBlur: () => {
      if (abort.current) {
        abort.current = false;
        setDraft(null);
        return;
      }
      flush();
    },
    onKeyDown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        (e.target as HTMLInputElement).blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        abort.current = true;
        (e.target as HTMLInputElement).blur();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // Compensate for the native type="number" spin-button/arrow-key step
        // that a type="text" input doesn't get for free.
        e.preventDefault();
        const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
        const base = draft !== null && Number.isFinite(Number(draft)) ? Number(draft) : display;
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        onCommit(clampToField(fs, base + dir * arrowStep * mult));
        setDraft(null);
      }
    },
    flush,
  };
}
