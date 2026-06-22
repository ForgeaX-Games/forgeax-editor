// Keyframe animation model (design EDITOR-MODE P2/P3 Timeline + the studio
// prototype's "逐帧插值 linear / step / smooth"). This is the PURE data + sampling
// math (no React/engine), unit-tested headlessly; the Timeline panel and the
// editor scrub preview are thin shells over it. A Clip animates named channels
// (e.g. "Transform.x") via sorted keyframes; sampling a clip at time t yields a
// flat { channel: value } the editor projects onto the world for preview.

export type Interp = 'linear' | 'step' | 'smooth';

export interface Keyframe {
  /** time in seconds */
  t: number;
  /** scalar value at this key */
  v: number;
  /** how to interpolate from THIS key to the next (default 'linear') */
  interp?: Interp;
}
export interface Track {
  /** "Component.field", e.g. "Transform.x" / "Transform.rotY" / "Material.metallic" */
  channel: string;
  keys: Keyframe[];
}
export interface Clip {
  duration: number;
  tracks: Track[];
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
/** smoothstep easing (3u²−2u³). */
export const smoothstep = (u: number): number => { const x = clamp01(u); return x * x * (3 - 2 * x); };

/** Sample a sorted keyframe list at time `t`. Holds the first key before the
 *  start and the last key after the end; returns undefined for an empty list. */
export function sampleTrack(keys: readonly Keyframe[], t: number): number | undefined {
  const n = keys.length;
  if (n === 0) return undefined;
  if (t <= keys[0]!.t) return keys[0]!.v;
  if (t >= keys[n - 1]!.t) return keys[n - 1]!.v;
  // find the segment [a, b] with a.t <= t < b.t (binary search; keys are sorted).
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (keys[mid]!.t <= t) lo = mid; else hi = mid; }
  const a = keys[lo]!, b = keys[hi]!;
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  const u = (t - a.t) / span;
  switch (a.interp ?? 'linear') {
    case 'step': return a.v;
    case 'smooth': return lerp(a.v, b.v, smoothstep(u));
    default: return lerp(a.v, b.v, u);
  }
}

/** Sample every track of a clip at `t` → { channel: value }. */
export function sampleClip(clip: Clip, t: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const tr of clip.tracks) { const v = sampleTrack(tr.keys, t); if (v !== undefined) out[tr.channel] = v; }
  return out;
}

const EPS = 1e-6;

/** Insert (or replace, if within EPS of an existing key's time) a keyframe,
 *  keeping the list sorted by time. Pure — returns a new array. */
export function upsertKey(keys: readonly Keyframe[], key: Keyframe): Keyframe[] {
  const out = keys.filter((k) => Math.abs(k.t - key.t) > EPS);
  out.push(key);
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Remove the keyframe at (≈) time `t`. Pure. */
export function removeKeyAt(keys: readonly Keyframe[], t: number): Keyframe[] {
  return keys.filter((k) => Math.abs(k.t - t) > EPS);
}

/** A track's last keyframe time (0 if empty). */
export function trackEnd(track: Track): number {
  return track.keys.length ? track.keys[track.keys.length - 1]!.t : 0;
}

/** The clip's natural duration = the latest keyframe across all tracks. */
export function clipDuration(clip: Clip): number {
  return clip.tracks.reduce((m, tr) => Math.max(m, trackEnd(tr)), 0);
}

export function emptyClip(duration = 4): Clip {
  return { duration, tracks: [] };
}

/** Find a track by channel, or null. */
export function findTrack(clip: Clip, channel: string): Track | null {
  return clip.tracks.find((t) => t.channel === channel) ?? null;
}

/** Upsert a keyframe on `channel` (creating the track if needed). Returns a new
 *  clip with duration grown to fit. Pure. */
export function setKey(clip: Clip, channel: string, key: Keyframe): Clip {
  const tracks = clip.tracks.some((t) => t.channel === channel)
    ? clip.tracks.map((t) => (t.channel === channel ? { ...t, keys: upsertKey(t.keys, key) } : t))
    : [...clip.tracks, { channel, keys: [key] }];
  const next: Clip = { ...clip, tracks };
  return { ...next, duration: Math.max(next.duration, clipDuration(next)) };
}

/** Remove a keyframe at time `t` from `channel`; drops the track if it empties. */
export function removeKey(clip: Clip, channel: string, t: number): Clip {
  const tracks = clip.tracks
    .map((tr) => (tr.channel === channel ? { ...tr, keys: removeKeyAt(tr.keys, t) } : tr))
    .filter((tr) => tr.keys.length > 0);
  return { ...clip, tracks };
}
