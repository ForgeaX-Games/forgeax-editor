// @forgeax/editor-core — hex <-> float color conversion utilities
//
// feat-20260701-editor-world-container-doc-ecs-collapse M6 / AC-19:
// Material panel transforms between hex color strings and sRGB-authored
// MaterialAsset.values. These helpers intentionally do no transfer-function
// conversion: the asset -> render extraction boundary owns sRGB -> linear.
//
// research F-MaterialAsset: editor schema.ts used hex strings, engine uses
// float arrays (baseColor: [r,g,b,a]).
// plan-strategy S7 M6: task m6-impl-material-panel creates color-utils.ts

import { linearChannelToSrgb, srgbChannelToLinear } from '@forgeax/engine-types';

export type AuthoredColorSpace = 'srgb' | 'linear';

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

/** Present an authored material color through the browser's sRGB color input. */
export function materialColorToHex(
  rgba: readonly number[],
  colorSpace: AuthoredColorSpace = 'srgb',
): string {
  return floatToHex(
    colorSpace === 'linear'
      ? rgba.map((channel, index) => (index < 3 ? linearChannelToSrgb(channel) : channel))
      : rgba,
  );
}

/** Convert an sRGB color-input value back to the asset's declared color space. */
export function hexToMaterialColor(
  hex: string,
  alpha = 1,
  colorSpace: AuthoredColorSpace = 'srgb',
): [number, number, number, number] {
  const [r, g, b] = hexToFloat(hex);
  return colorSpace === 'linear'
    ? [srgbChannelToLinear(r), srgbChannelToLinear(g), srgbChannelToLinear(b), alpha]
    : [r, g, b, alpha];
}
