// CBInlineRename — the ONE inline-edit input shared by every Content Browser
// surface (grid asset/folder/file cards + source-tree rows). It owns only the
// editing INTERACTION (autofocus/select, Enter/Escape/blur, live validation
// feedback); the subject-specific commit (asset name field vs directory/file
// path rename, authorization gates, reselection) lives in one `onCommit`
// handler in ContentBrowser. Keeping this a single component is why the
// keybinding, the input render, and the validation are authored exactly once.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

interface Props {
  /** Current name; pre-filled and selected on mount. */
  initial: string;
  /** Optional basename validator (same SSOT the applier enforces). Returns a
   *  hint string when invalid, or null when valid. */
  validate?: (value: string) => string | null;
  /** Fired with the trimmed new name once the user confirms a valid change. */
  onCommit: (value: string) => void;
  /** Fired when the edit is abandoned (Escape, empty, unchanged, or blur-away
   *  from an invalid value). */
  onCancel: () => void;
  className?: string;
  ariaLabel?: string;
}

export function CBInlineRename({ initial, validate, onCommit, onCancel, className, ariaLabel }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Guard against double-settling (e.g. Enter fires onCommit, then the ensuing
  // unmount/blur would fire a second time against a stale value).
  const settled = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const settle = (mode: 'commit' | 'cancel', fromBlur = false) => {
    if (settled.current) return;
    if (mode === 'cancel') { settled.current = true; onCancel(); return; }
    const value = (ref.current?.value ?? initial).trim();
    // Empty or unchanged is a no-op, not a rename.
    if (value === '' || value === initial) { settled.current = true; onCancel(); return; }
    const hint = validate?.(value) ?? null;
    if (hint) {
      // Keyboard-confirm on an invalid value keeps the field open with red
      // feedback; blurring away from an invalid value reverts (UE parity).
      if (fromBlur) { settled.current = true; onCancel(); return; }
      setError(hint);
      return;
    }
    settled.current = true;
    onCommit(value);
  };

  return (
    <input
      ref={ref}
      className={`cb-inline-rename${error ? ' is-invalid' : ''}${className ? ` ${className}` : ''}`}
      defaultValue={initial}
      spellCheck={false}
      autoComplete="off"
      aria-label={ariaLabel}
      aria-invalid={error ? true : undefined}
      title={error ?? undefined}
      data-testid="cb-inline-rename"
      // Stop the row/card beneath from treating the edit interaction as a
      // select/activate, and stop keys from bubbling to the grid/tree keybinding
      // scope (which would re-trigger rename/delete/select-all commands).
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={() => {
        if (error) setError(validate?.((ref.current?.value ?? '').trim()) ?? null);
      }}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); settle('commit'); }
        else if (e.key === 'Escape') { e.preventDefault(); settle('cancel'); }
      }}
      onBlur={() => settle('commit', true)}
    />
  );
}
