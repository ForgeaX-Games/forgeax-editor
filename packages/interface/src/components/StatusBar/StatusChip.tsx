/**
 * StatusChip — the single visual primitive for chips inside GlobalStatusBar.
 *
 * Every feed that wants to appear on the status bar should render exactly one
 * of these so the bar reads as a coherent strip (uniform height, font, dot
 * size, value alignment).  The only thing that varies is the `tone` color —
 * which gets applied to the leading dot + icon + label uppercase mono; the
 * `value` stays neutral (`--text`) so numbers across kinds are scannable at
 * a glance.
 *
 * Why a dedicated component instead of inline JSX in PulseFeeds: when chips
 * are spread across multiple feed files (and eventually multiple plugins),
 * having a single component means visual drift is bounded — any change here
 * propagates everywhere without per-feed CSS churn.
 *
 *   ● BUS 2,076    ● MB 1    ● PROV 2/4    ● SKILL 1    ● TOOL 1    ● AGENT 1
 *   ─┬──┬─ ─┬───
 *    │  │   └ value (neutral, mono, tabular)
 *    │  └ label (toned, mono, uppercase)
 *    └ dot (toned, optional flash keyframe)
 */

import type { LucideIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import './StatusChip.css';

export type ChipTone =
  | 'lime'   // BUS — events flowing
  | 'teal'   // MB
  | 'amber'  // PROV
  | 'gold'   // SKILL
  | 'orange' // TOOL
  | 'violet' // AGENT
  | 'red'    // error / down
  | 'mute';  // loading / dim

export type ChipState = 'ok' | 'down' | 'loading' | 'empty' | 'warn';

export interface StatusChipProps {
  tone: ChipTone;
  state?: ChipState;
  icon?: LucideIcon | null;
  label: string;
  value: string;
  title?: string;
  onClick?: () => void;
  /** Bus pulse uses this — bumps a key to retrigger the dot's flash keyframe. */
  flashKey?: number;
  /** Optional aria override; defaults to `${label} ${value}`. */
  ariaLabel?: string;
}

export function StatusChip({
  tone,
  state = 'ok',
  icon: Icon,
  label,
  value,
  title,
  onClick,
  flashKey = 0,
  ariaLabel,
}: StatusChipProps): ReactElement {
  const className = [
    'sb-chip',
    onClick ? 'is-link' : '',
  ].filter(Boolean).join(' ');

  const inner = (
    <>
      <span className="sb-chip-label">{label}</span>
      <span className="sb-chip-value">{value}</span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        title={title}
        onClick={onClick}
        aria-label={ariaLabel ?? `${label} ${value}`}
      >
        {inner}
      </button>
    );
  }
  return (
    <div
      className={className}
      title={title}
      role="status"
      aria-label={ariaLabel ?? `${label} ${value}`}
    >
      {inner}
    </div>
  );
}
