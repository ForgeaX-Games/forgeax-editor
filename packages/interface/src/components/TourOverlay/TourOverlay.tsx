// TourOverlay — a reusable coach-mark tour that highlights live shell elements
// by their `data-tour-id` attribute. Business-agnostic: the caller supplies the
// step list + copy; this component owns geometry, keyboard a11y, and focus.
//
// Anchor registry: elements opt in by rendering `data-tour-id="<id>"`. The
// overlay resolves each step's anchor with `querySelector`, tracks its
// bounding rect (recomputed on resize/scroll), paints a highlight ring, and
// floats the coach card on the side with the most room. Missing anchor →
// the card centers and the ring hides (tour still advances).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import './TourOverlay.css';

export interface TourStep {
  /** Matches a `data-tour-id="<id>"` attribute somewhere in the shell. */
  anchorId: string;
  /** Bold heading of the coach card. */
  anchor: string;
  /** Body copy. */
  body: string;
}

export interface TourOverlayProps {
  steps: TourStep[];
  stepIndex: number;
  onStepChange: (next: number) => void;
  /** Called when the user finishes the last step or skips. `completed` is true
   *  only when advancing past the final step. */
  onClose: (completed: boolean) => void;
  labels: {
    prev: string;
    skip: string;
    next: string;
    done: string;
  };
}

interface Rect { top: number; left: number; width: number; height: number }

const RING_PAD = 4;
const RING_OUTLINE = 2;
const COACH_GAP = 12;
const COACH_W = 260;
const COACH_H_EST = 150;
const VIEWPORT_PAD = 12;

function readAnchorRect(anchorId: string): Rect | null {
  const el = document.querySelector<HTMLElement>(`[data-tour-id="${CSS.escape(anchorId)}"]`);
  if (!el) return null;
  // Panel anchors are out-of-flow zero-size markers (see panelRegistry.tourWrap):
  // their own rect is empty, so measure the parent — the dockview content box
  // that IS the panel's area. Other anchors (topbar regions, composer) are real
  // elements measured directly.
  const target = el.hasAttribute('data-tour-anchor-parent') ? el.parentElement : el;
  if (!target) return null;
  const r = target.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/** Ring box = anchor grown by RING_PAD, then clamped inside the viewport. The
 *  2px outline is painted OUTSIDE the box, so when an anchor hugs a viewport edge
 *  the raw ring (anchor - RING_PAD) spills off-screen and that side of the
 *  highlight disappears. Clamp each edge to keep the whole ring (incl. outline)
 *  visible. */
function ringBox(anchor: Rect): Rect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const min = RING_OUTLINE;
  const top = Math.max(min, anchor.top - RING_PAD);
  const left = Math.max(min, anchor.left - RING_PAD);
  const bottom = Math.min(vh - min, anchor.top + anchor.height + RING_PAD);
  const right = Math.min(vw - min, anchor.left + anchor.width + RING_PAD);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Choose a coach position (below → above → right → left → centered) that fits
 *  the viewport, then clamp inside it. */
function coachPosition(anchor: Rect | null): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!anchor) {
    return { top: Math.max(VIEWPORT_PAD, vh / 2 - COACH_H_EST / 2), left: vw / 2 - COACH_W / 2 };
  }
  const belowTop = anchor.top + anchor.height + COACH_GAP;
  const aboveTop = anchor.top - COACH_H_EST - COACH_GAP;
  let top: number;
  let left: number;
  if (belowTop + COACH_H_EST <= vh - VIEWPORT_PAD) {
    top = belowTop;
    left = anchor.left + anchor.width / 2 - COACH_W / 2;
  } else if (aboveTop >= VIEWPORT_PAD) {
    top = aboveTop;
    left = anchor.left + anchor.width / 2 - COACH_W / 2;
  } else if (anchor.left + anchor.width + COACH_GAP + COACH_W <= vw - VIEWPORT_PAD) {
    top = anchor.top;
    left = anchor.left + anchor.width + COACH_GAP;
  } else {
    top = anchor.top;
    left = anchor.left - COACH_W - COACH_GAP;
  }
  top = Math.min(Math.max(VIEWPORT_PAD, top), vh - COACH_H_EST - VIEWPORT_PAD);
  left = Math.min(Math.max(VIEWPORT_PAD, left), vw - COACH_W - VIEWPORT_PAD);
  return { top, left };
}

export function TourOverlay({ steps, stepIndex, onStepChange, onClose, labels }: TourOverlayProps) {
  const step = steps[stepIndex];
  // Anchor id is the ONLY stable identity of a step: `steps`/`step` are rebuilt
  // (new object refs) on every parent render because their copy comes from the
  // i18n `t()` closure. Keying effects on the object would re-run them every
  // render and reset the retry timer before it can fire — so key on this string.
  const anchorId = step?.anchorId;
  const [anchorRect, setAnchorRect] = useState<Rect | null>(null);
  const coachRef = useRef<HTMLDivElement>(null);
  const isLast = stepIndex >= steps.length - 1;
  const isFirst = stepIndex <= 0;

  const recompute = useCallback(() => {
    if (!anchorId) return;
    setAnchorRect(readAnchorRect(anchorId));
  }, [anchorId]);

  // Measure the current step's anchor, RETRYING until it has a real rect. The
  // dockview panels (sidebar/preview/chat) lay out asynchronously after mount,
  // so a one-shot measure on step 0 lands before the panel has a size → null →
  // no ring (the classic "first step doesn't highlight" bug). Poll briefly until
  // a non-zero rect appears, then stop; give up after ~1.2s (anchor genuinely
  // absent → coach just centers).
  useLayoutEffect(() => {
    if (!anchorId) return;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const tick = () => {
      const rect = readAnchorRect(anchorId);
      setAnchorRect(rect);
      attempts += 1;
      if (rect || attempts >= 20) return;
      timer = setTimeout(tick, 60);
    };
    tick();
    return () => clearTimeout(timer);
  }, [anchorId]);

  useEffect(() => {
    const onWin = () => recompute();
    window.addEventListener('resize', onWin);
    window.addEventListener('scroll', onWin, true);
    return () => {
      window.removeEventListener('resize', onWin);
      window.removeEventListener('scroll', onWin, true);
    };
  }, [recompute]);

  const goNext = useCallback(() => {
    if (isLast) onClose(true);
    else onStepChange(stepIndex + 1);
  }, [isLast, onClose, onStepChange, stepIndex]);

  const goPrev = useCallback(() => {
    if (!isFirst) onStepChange(stepIndex - 1);
  }, [isFirst, onStepChange, stepIndex]);

  // Keyboard a11y: Esc skips, arrows/Enter navigate. Focus the coach on mount /
  // step change so screen readers announce the new content and Tab is trapped.
  useEffect(() => {
    coachRef.current?.focus();
  }, [stepIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(false); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); goNext(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
      else if (e.key === 'Tab') {
        // single focusable container — keep focus inside.
        const focusables = coachRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)');
        if (!focusables || focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [goNext, goPrev, onClose]);

  if (!step) return null;
  const coach = coachPosition(anchorRect);
  const ring = anchorRect ? ringBox(anchorRect) : null;
  // evenodd polygon: full viewport minus the ring rect → dim everywhere except
  // the highlighted panel (which stays undimmed).
  const scrimClip = ring
    ? `polygon(evenodd, 0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, ${ring.left}px ${ring.top}px, ${ring.left}px ${ring.top + ring.height}px, ${ring.left + ring.width}px ${ring.top + ring.height}px, ${ring.left + ring.width}px ${ring.top}px, ${ring.left}px ${ring.top}px)`
    : undefined;

  return (
    <div className="tour-root" role="dialog" aria-modal="true" aria-label={step.anchor}>
      {/* Scrim is a click SINK, not a dismiss target: clicking anywhere outside
          the coach must NOT quit the tour (only the explicit Skip button / Esc
          do). clip-path punches a hole over the anchor so that panel stays clear
          while the rest of the shell stays dimmed. */}
      <div
        className="tour-scrim"
        style={scrimClip ? { clipPath: scrimClip } : undefined}
        onClick={(e) => e.stopPropagation()}
      />
      {ring && (
        <>
          {/* Hole is clipped out of the scrim, so a separate sink blocks clicks
              on the highlighted panel (tour stays non-interactive). */}
          <div
            className="tour-hole-sink"
            style={{ top: ring.top, left: ring.left, width: ring.width, height: ring.height }}
            onClick={(e) => e.stopPropagation()}
          />
          <div
            className="tour-ring"
            style={{ top: ring.top, left: ring.left, width: ring.width, height: ring.height }}
          />
        </>
      )}
      <div
        className="tour-coach"
        ref={coachRef}
        tabIndex={-1}
        style={{ top: coach.top, left: coach.left, width: COACH_W }}
      >
        <div className="tour-coach-head">
          <span className="tour-coach-count">{stepIndex + 1} / {steps.length}</span>
          <span className="tour-coach-anchor">{step.anchor}</span>
        </div>
        <div className="tour-coach-body">{step.body}</div>
        <div className="tour-coach-actions">
          <button type="button" className="tour-btn tour-btn-ghost" onClick={goPrev} disabled={isFirst}>
            {labels.prev}
          </button>
          <div style={{ flex: 1 }} />
          <button type="button" className="tour-btn tour-btn-ghost" onClick={() => onClose(false)}>
            {labels.skip}
          </button>
          <button type="button" className="tour-btn tour-btn-primary" onClick={goNext}>
            {isLast ? labels.done : labels.next}
          </button>
        </div>
      </div>
    </div>
  );
}
