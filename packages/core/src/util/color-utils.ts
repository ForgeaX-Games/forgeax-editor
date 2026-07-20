// @forgeax/editor-core — hex <-> float color conversion utilities
//
// feat-20260701-editor-world-container-doc-ecs-collapse M6 / AC-19:
// Material panel transforms between hex color strings (UI display) and engine
// float arrays (MaterialAsset.paramValues). 8-bit precision ensures AC-11
// color round-trip zero loss.
//
// research F-MaterialAsset: editor schema.ts used hex strings, engine uses
// float arrays (baseColor: [r,g,b,a]).
// plan-strategy S7 M6: task m6-impl-material-panel creates color-utils.ts

/**
 * Convert an 8-bit-per-channel hex color string to a float RGBA array.
 *
 * @param hex - 6-digit hex color (e.g. "#ff0000")
 * @returns `[r, g, b, a]` with each channel in [0,1], alpha always 1.0
 * @throws if hex format is invalid
 */
export function hexToFloat(hex: string): [number, number, number, number] {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`hexToFloat: invalid hex color "${hex}"`);
  }
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
    1.0,
  ];
}

/**
 * Convert a float RGBA array to an 8-bit-per-channel hex color string.
 *
 * @param rgba - Float array with at least 3 channels in [0,1]
 * @returns 6-digit hex string (e.g. "#ff0000")
 */
export function floatToHex(rgba: readonly number[]): string {
  const ch = (v: number): string =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${ch(rgba[0] ?? 0)}${ch(rgba[1] ?? 0)}${ch(rgba[2] ?? 0)}`;
}