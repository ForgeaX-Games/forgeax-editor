import { describe, expect, it } from 'bun:test';
import { computeAssetPickerPlacement } from '../asset-picker-placement';

describe('computeAssetPickerPlacement', () => {
  it('opens below when there is more space under the anchor', () => {
    const placement = computeAssetPickerPlacement(
      { top: 100, bottom: 140, left: 200, right: 360, width: 160, height: 40 },
      320,
    );
    expect(placement.placement).toBe('below');
    expect(placement.top).toBe(144);
    expect(placement.left).toBe(200);
    expect(placement.width).toBeGreaterThanOrEqual(300);
  });

  it('opens above when space below is tight and above is larger', () => {
    const placement = computeAssetPickerPlacement(
      { top: 520, bottom: 560, left: 80, right: 240, width: 160, height: 40 },
      320,
    );
    expect(placement.placement).toBe('above');
    expect(placement.top).toBeLessThan(520);
    expect(placement.maxHeight).toBeGreaterThan(0);
  });
});
