import { describe, expect, it } from 'bun:test';
import { inspectorFieldLabel } from '../inspector-field-label';

describe('inspectorFieldLabel', () => {
  it('splits camelCase and capitalizes the first word', () => {
    expect(inspectorFieldLabel('assetHandle')).toBe('Asset Handle');
    expect(inspectorFieldLabel('nearClip')).toBe('Near Clip');
    expect(inspectorFieldLabel('castShadow')).toBe('Cast Shadow');
  });

  it('capitalizes short lowercase keys', () => {
    expect(inspectorFieldLabel('pos')).toBe('Pos');
    expect(inspectorFieldLabel('scale')).toBe('Scale');
    expect(inspectorFieldLabel('materials')).toBe('Materials');
  });

  it('leaves already-capitalized single words unchanged aside from first letter', () => {
    expect(inspectorFieldLabel('rotation')).toBe('Rotation');
  });
});
