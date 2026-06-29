/**
 * Health / INFO store — Blender-style status feed for the studio shell.
 *
 * Why this exists: the engine runs inside cross-origin iframes (Play :15173 /
 * Edit :15280) and plugin panels. When a scene fails to instantiate, the GPU
 * device is lost, a module is missing, or WebGPU init fails, the only signal
 * today lands in the *iframe's* DevTools console — which the shell can't read
 * and the user never sees (they stare at a black / empty viewport and guess).
 *
 * This module is the single sink for every health signal in the shell:
 *   - the shell's own window.onerror / unhandledrejection / console.error
 *   - iframe-forwarded `forgeax:health` postMessages (play / edit / plugin)
 *   - the existing VAG_CONSOLE / VAG_DEVICE_LOST wire (bridged in)
 *
 * It is a tiny standalone zustand store (not folded into the 3k-line app
 * store.ts) so the status bar stays decoupled and cheap. The shell shows a
 * scrolling severity-tagged log + a fatal banner per Play/Edit region.
 */

import { create } from 'zustand';
import { recordLog } from '../../lib/logSink';

export type HealthLevel = 'info' | 'success' | 'warn' | 'error';
export type HealthSource = 'play' | 'edit' | 'plugin' | 'shell' | 'engine';

export interface HealthEntry {
  id: number;
  ts: number;
  level: HealthLevel;
  source: HealthSource;
  /** Machine-readable code when known (e.g. 'device-lost', 'scene-instantiate-failed'). */
  code?: string;
  message: string;
}

/**
 * Codes we treat as FATAL for a region — they black/empty the viewport and
 * the user needs an explicit "what broke + retry" affordance, not just a log
 * line. Matched against entry.code OR substring-matched against the message
 * text (the engine's existing console output is plain text, not coded).
 */
export const FATAL_CODES = new Set<string>([
  'device-lost',
  'context-lost',
  'scene-instantiate-failed',
  'webgpu-init-failed',
  'module-missing',
  'load-timeout',
  'createApp-failed',
]);

/** Heuristic text patterns that mark a console error as a fatal region failure. */
const FATAL_TEXT_PATTERNS: RegExp[] = [
  /scene\s+instantiate\s+failed/i,
  /device\s*lost/i,
  /context\s*lost/i,
  /createApp\s+failed/i,
  /engine\s+init\s+failed/i,
  /no\s+usable\s+backend/i,
  /webgpu\s+(adapter|unavailable|requires)/i,
  /failed\s+to\s+resolve\s+(import|module)/i,
  /does\s+not\s+provide\s+an\s+export/i,
  /loadByGuid.*fail/i,
];

export interface FatalState {
  level: HealthLevel;
  code?: string;
  message: string;
  ts: number;
}

interface HealthStore {
  entries: HealthEntry[];
  collapsed: boolean;
  /** Latest fatal per region, surfaced as a banner over Play / Edit. null = clear. */
  fatal: Record<HealthSource, FatalState | null>;
  push: (e: Omit<HealthEntry, 'id' | 'ts'> & { ts?: number }) => void;
  clear: () => void;
  toggleCollapsed: () => void;
  setCollapsed: (v: boolean) => void;
  clearFatal: (source: HealthSource) => void;
}

const MAX_ENTRIES = 400;
let _seq = 1;

function isFatal(level: HealthLevel, code: string | undefined, message: string): boolean {
  if (level !== 'error') return false;
  if (code && FATAL_CODES.has(code)) return true;
  return FATAL_TEXT_PATTERNS.some((re) => re.test(message));
}

export const useHealthStore = create<HealthStore>((set) => ({
  entries: [],
  collapsed: true,
  fatal: { play: null, edit: null, plugin: null, shell: null, engine: null },

  push: (e) => set((s) => {
    const entry: HealthEntry = {
      id: _seq++,
      ts: e.ts ?? Date.now(),
      level: e.level,
      source: e.source,
      code: e.code,
      message: e.message,
    };
    recordLog('info', entry); // mirror to disk (.forgeax/logs/info.jsonl)
    const next = s.entries.length >= MAX_ENTRIES
      ? [...s.entries.slice(s.entries.length - (MAX_ENTRIES - 1)), entry]
      : [...s.entries, entry];

    // Promote fatal region failures into the banner channel.
    if (isFatal(entry.level, entry.code, entry.message)) {
      return {
        entries: next,
        fatal: {
          ...s.fatal,
          [entry.source]: {
            level: entry.level,
            code: entry.code,
            message: entry.message,
            ts: entry.ts,
          },
        },
      };
    }
    return { entries: next };
  }),

  clear: () => set({ entries: [] }),
  toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
  setCollapsed: (v) => set({ collapsed: v }),
  clearFatal: (source) => set((s) => ({ fatal: { ...s.fatal, [source]: null } })),
}));

/** Imperative push for non-React call sites (boot hooks, message listeners). */
export function pushHealth(e: Omit<HealthEntry, 'id' | 'ts'> & { ts?: number }): void {
  useHealthStore.getState().push(e);
}

// ── Blender-INFO-style helpers (consumed by InfoPanel / HealthStatusBar) ──────

/** A run of consecutive identical entries (same source+message), folded to one
 *  row with a repeat count — like Blender's INFO editor folds repeated ops. */
export interface CollapsedEntry {
  /** The most-recent entry in the run (we render its ts as "last seen"). */
  entry: HealthEntry;
  /** How many consecutive identical entries this row represents (>= 1). */
  count: number;
  /** Stable key for React — the id of the FIRST entry in the run. */
  key: number;
}

/**
 * Fold consecutive identical entries (same source + same message; ts ignored)
 * into one CollapsedEntry carrying a count. Non-consecutive repeats are NOT
 * merged (Blender behaviour) — only a contiguous flood collapses, so a
 * PickError firing 14 frames in a row shows as a single `×14` row.
 */
export function collapseEntries(entries: HealthEntry[]): CollapsedEntry[] {
  const out: CollapsedEntry[] = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (prev && prev.entry.source === e.source && prev.entry.message === e.message) {
      prev.count += 1;
      prev.entry = e; // keep latest ts/id for "last seen"
    } else {
      out.push({ entry: e, count: 1, key: e.id });
    }
  }
  return out;
}

/** Full, copy-friendly one-line text for an entry (source · time · message). */
export function entryToText(e: HealthEntry, count = 1): string {
  const d = new Date(e.ts);
  const p = (n: number) => String(n).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const tag = `[${e.level.toUpperCase()}] ${e.source}${e.code ? `/${e.code}` : ''}`;
  const rep = count > 1 ? ` (×${count})` : '';
  return `${time} ${tag}${rep}: ${e.message}`;
}
