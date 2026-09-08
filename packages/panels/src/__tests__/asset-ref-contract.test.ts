import { describe, expect, it } from 'bun:test';
import { expectedAssetType, resolveAssetGuid, resolveAssetHandle } from '../asset-ref-contract';

describe('asset-ref-contract', () => {
  it('exposes expectedAssetType as a pure gateway describe helper', () => {
    expect(typeof expectedAssetType).toBe('function');
  });

  it('treats non-positive handles as unbound', () => {
    expect(resolveAssetHandle(0)).toEqual({ bound: false, missing: false, name: '' });
    expect(resolveAssetHandle(-1)).toEqual({ bound: false, missing: false, name: '' });
  });

  it('treats empty guid as unbound', () => {
    expect(resolveAssetGuid(null)).toEqual({ bound: false, missing: false, name: '' });
    expect(resolveAssetGuid(undefined)).toEqual({ bound: false, missing: false, name: '' });
    expect(resolveAssetGuid('')).toEqual({ bound: false, missing: false, name: '' });
  });
});
