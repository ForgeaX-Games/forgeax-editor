// Shared resize primitive — a pointer-capture drag handle + a localStorage-backed
// size hook. SSOT for editor-wide splitters (Content Browser source panel, dock
// panes, …) so every host gets identical drag ergonomics / persistence without
// duplicating the logic (charter: single-source reuse).
//
// The handle is styling-agnostic: it emits `resize-handle resize-handle-<col|row>`
// classNames and each host supplies the matching CSS (a 1px centre line + hover
// highlight is the house style). Zero cost when idle — just a <div> with pointer
// listeners. Callers that want a re-render-free drag can update DOM imperatively
// inside `onDrag` and commit persisted state once in `onDragEnd`.

import { useEffect, useRef, useState, type PointerEvent } from 'react';

/**
 * localStorage-backed, min/max-clamped numeric size state.
 *
 * @param key     localStorage key (per-splitter, e.g. "cb.sourceWidth")
 * @param initial default when nothing is persisted yet
 * @param min     lower clamp
 * @param max     upper clamp
 */
export function useLocalSize(
  key: string,
  initial: number,
  min: number,
  max: number,
): readonly [number, (next: number | ((prev: number) => number)) => void] {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const [value, setValueRaw] = useState<number>(() => {
    if (typeof window === 'undefined') return initial;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return initial;
      const n = Number(raw);
      if (!Number.isFinite(n)) return initial;
      return clamp(n);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      /* localStorage may throw in privacy mode / over quota — fine, just don't persist */
    }
  }, [key, value]);
  const setValue = (next: number | ((prev: number) => number)) => {
    setValueRaw((prev) =>
      clamp(typeof next === 'function' ? (next as (p: number) => number)(prev) : next),
    );
  };
  return [value, setValue] as const;
}

interface ResizeHandleProps {
  orientation: 'col' | 'row';
  /** Called on every pointer move with the incremental delta (px) since last move. */
  onDrag: (delta: number) => void;
  /** Called once when the drag ends (pointer up / cancel). Use to commit + persist. */
  onDragEnd?: () => void;
  title?: string;
}

export function ResizeHandle({ orientation, onDrag, onDragEnd, title }: ResizeHandleProps) {
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    startRef.current = { x: e.clientX, y: e.clientY };
    document.body.style.cursor = orientation === 'col' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return;
    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;
    startRef.current = { x: e.clientX, y: e.clientY };
    onDrag(orientation === 'col' ? dx : dy);
  };
  const finish = (e: PointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return;
    startRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer may have already been released by the browser — safe to ignore */
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    onDragEnd?.();
  };
  return (
    <div
      className={`resize-handle resize-handle-${orientation}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      title={title}
      role="separator"
      aria-orientation={orientation === 'col' ? 'vertical' : 'horizontal'}
    />
  );
}
