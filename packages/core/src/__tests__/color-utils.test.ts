import { describe, expect, it } from 'bun:test';
import {
  hexToMaterialColor,
  materialColorToHex,
} from '../util/color-utils';

describe('material authoring color utilities', () => {
  it('stores default-sRGB picker values without numerical conversion', () => {
    expect(hexToMaterialColor('#8040bf', 0.4)).toEqual([
      128 / 255,
      64 / 255,
      191 / 255,
      0.4,
    ]);
    expect(materialColorToHex([128 / 255, 64 / 255, 191 / 255, 0.4])).toBe('#8040bf');
  });

  it('uses the exact sRGB transfer function for explicitly-linear assets', () => {
    const linear = hexToMaterialColor('#8040bf', 0.4, 'linear');
    expect(linear[0]).toBeCloseTo(0.2158605, 6);
    expect(linear[1]).toBeCloseTo(0.0512695, 6);
    expect(linear[2]).toBeCloseTo(0.5209956, 6);
    expect(linear[3]).toBe(0.4);
    expect(materialColorToHex(linear, 'linear')).toBe('#8040bf');
  });
});
