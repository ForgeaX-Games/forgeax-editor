import { describe, expect, it } from 'bun:test';
import { isVirtualRootPath, VIRTUAL_ROOT_PATH } from '../virtual-root';

describe('virtual root', () => {
  it('uses an empty game-relative path', () => {
    expect(VIRTUAL_ROOT_PATH).toBe('');
    expect(isVirtualRootPath('')).toBe(true);
    expect(isVirtualRootPath('assets')).toBe(false);
  });
});
