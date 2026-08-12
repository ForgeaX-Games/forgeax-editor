import { describe, expect, it } from 'bun:test';
import { createBootLease } from '../boot-lease';

describe('viewport boot lease', () => {
  it('invalidates an in-flight boot before the next game can become current', () => {
    const lease = createBootLease();
    const first = lease.begin();

    expect(lease.isCurrent(first)).toBe(true);
    lease.invalidate();
    expect(lease.isCurrent(first)).toBe(false);

    const second = lease.begin();
    expect(lease.isCurrent(first)).toBe(false);
    expect(lease.isCurrent(second)).toBe(true);
  });
});
