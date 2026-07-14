import { describe, expect, it, beforeEach } from 'bun:test';
import { registerAction, __resetRegistryForTest } from './action-registry';
import {
  TRAJECTORY_MAX,
  clearTrajectory,
  readTrajectory,
  recordTrajectory,
} from './ui-trajectory';

// A no-op action so recordTrajectory can derive title/capability from the registry.
function reg(id: string, capability: 'read' | 'write' | 'credential' = 'read') {
  registerAction({ id, title: `T:${id}`, capability, run: () => {} });
}

describe('ui-trajectory', () => {
  beforeEach(() => {
    __resetRegistryForTest();
    clearTrajectory();
  });

  it('records human + AI ops and derives title/capability from the registry', () => {
    reg('app.set_mode', 'write');
    recordTrajectory({ id: 'app.set_mode', source: 'human', args: { mode: 'play' } });
    recordTrajectory({ id: 'app.set_mode', source: 'ai', args: { mode: 'edit' } });
    const { total, entries } = readTrajectory();
    expect(total).toBe(2);
    expect(entries[0]).toMatchObject({ id: 'app.set_mode', title: 'T:app.set_mode', source: 'human', capability: 'write', args: { mode: 'play' } });
    expect(entries[1]).toMatchObject({ source: 'ai', args: { mode: 'edit' } });
    // seq is monotonic
    expect(entries[1].seq).toBeGreaterThan(entries[0].seq);
  });

  it('filters by source', () => {
    reg('x.a');
    recordTrajectory({ id: 'x.a', source: 'human' });
    recordTrajectory({ id: 'x.a', source: 'ai' });
    recordTrajectory({ id: 'x.a', source: 'ai' });
    expect(readTrajectory({ source: 'ai' }).total).toBe(2);
    expect(readTrajectory({ source: 'human' }).total).toBe(1);
  });

  it('redacts args for credential-capability actions', () => {
    reg('secret.save', 'credential');
    recordTrajectory({ id: 'secret.save', source: 'human', args: { token: 'sk-supersecret' } });
    expect(readTrajectory().entries[0].args).toEqual({ redacted: true });
  });

  it('shallow-trims long strings and nested values', () => {
    reg('x.big');
    const long = 'y'.repeat(400);
    recordTrajectory({ id: 'x.big', source: 'ai', args: { s: long, n: 5, obj: { a: 1 }, arr: [1, 2, 3] } });
    const a = readTrajectory().entries[0].args!;
    expect((a.s as string).length).toBeLessThan(long.length);
    expect(a.n).toBe(5);
    expect(a.obj).toBe('[object]');
    expect(a.arr).toBe('[array:3]');
  });

  it('skips self-introspection trajectory.* ops (no pollution)', () => {
    reg('trajectory.read');
    recordTrajectory({ id: 'trajectory.read', source: 'ai', args: { limit: 10 } });
    expect(readTrajectory().total).toBe(0);
  });

  it('caps the ring buffer at TRAJECTORY_MAX', () => {
    reg('x.a');
    for (let i = 0; i < TRAJECTORY_MAX + 50; i++) recordTrajectory({ id: 'x.a', source: 'human' });
    expect(readTrajectory({ limit: TRAJECTORY_MAX }).total).toBe(TRAJECTORY_MAX);
  });

  it('clear() empties the buffer and reports the count', () => {
    reg('x.a');
    recordTrajectory({ id: 'x.a', source: 'human' });
    recordTrajectory({ id: 'x.a', source: 'ai' });
    expect(clearTrajectory()).toBe(2);
    expect(readTrajectory().total).toBe(0);
  });
});
