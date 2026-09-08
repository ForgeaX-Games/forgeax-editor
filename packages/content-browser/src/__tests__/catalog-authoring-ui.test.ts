import { describe, expect, it } from 'bun:test';
import { creatableKindAllowedAtPath } from '../catalog-authoring-ui';

const ROOTS = [{ root: 'assets', catalogPrefix: 'assets' }] as const;

describe('creatableKindAllowedAtPath', () => {
  it('allows material and particle under assets subdirs', () => {
    expect(creatableKindAllowedAtPath('material', 'assets', ROOTS)).toBe(true);
    expect(creatableKindAllowedAtPath('material', 'assets/ui', ROOTS)).toBe(true);
    expect(creatableKindAllowedAtPath('particle-effect', 'assets/fx', ROOTS)).toBe(true);
  });

  it('blocks material and particle outside assets', () => {
    expect(creatableKindAllowedAtPath('material', '', ROOTS)).toBe(false);
    expect(creatableKindAllowedAtPath('material', 'src', ROOTS)).toBe(false);
    expect(creatableKindAllowedAtPath('material', 'test-material', ROOTS)).toBe(false);
    expect(creatableKindAllowedAtPath('particle-effect', 'src', ROOTS)).toBe(false);
  });

  it('does not restrict other creatable kinds', () => {
    expect(creatableKindAllowedAtPath('scene', '', ROOTS)).toBe(true);
    expect(creatableKindAllowedAtPath('input-map', 'src', ROOTS)).toBe(true);
  });
});
