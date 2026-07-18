// FNV-1a 32-bit hash of `name` reduced to a hue in [0, 360). Deterministic,
// zero-dependency, gives each slot name a stable distinct color for the debug
// overlay. Not cryptographic — visual bucketing only.
export function hashHue(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
}
