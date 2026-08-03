import { describe, expect, it } from 'bun:test';

import { hierarchyMobility } from '../hierarchy-state';

describe('hierarchy mobility projection', () => {
  it('distinguishes the physics RigidBody motion enum', () => {
    expect(hierarchyMobility({ Transform: {}, RigidBody: { type: 0 } })).toBe('stationary');
    expect(hierarchyMobility({ Transform: {}, RigidBody: { type: 1 } })).toBe('movable');
    expect(hierarchyMobility({ Transform: {}, RigidBody: { type: 2 } })).toBe('movable');
  });

  it('keeps presence fallback for older or incomplete rigid-body projections', () => {
    expect(hierarchyMobility({ Transform: {}, RigidBody: {} })).toBe('movable');
    expect(hierarchyMobility({ Transform: {} })).toBe('static');
  });
});
