import { describe, expect, it } from 'bun:test';
import { createPlayGameplayProjection } from '../gameplay-projection';

describe('remote Play gameplay projection', () => {
  it('discovers and invokes producer-owned actions and reads', async () => {
    const projection = createPlayGameplayProjection();
    let input: unknown = null;
    projection.registrar.registerAction({
      id: 'input',
      title: 'Input',
      run: (args) => { input = args; },
    });
    projection.registrar.registerRead({
      id: 'state',
      title: 'State',
      read: () => ({ score: 7, active: true }),
    });

    expect(projection.describe()).toEqual({
      actions: [{ id: 'input', title: 'Input' }],
      reads: [{ id: 'state', title: 'State' }],
    });
    expect(await projection.run('input', { key: 'ArrowRight' })).toEqual({ ok: true });
    expect(input).toEqual({ key: 'ArrowRight' });
    expect(await projection.read('state')).toEqual({ ok: true, data: { score: 7, active: true } });
  });

  it('fails closed for unknown or non-serializable projections', async () => {
    const projection = createPlayGameplayProjection();
    expect(await projection.read('missing')).toMatchObject({ ok: false, error: { code: 'unknown-game-projection' } });
    projection.registrar.registerRead({ id: 'bad', title: 'Bad', read: () => ({ value: BigInt(1) } as never) });
    expect(await projection.read('bad')).toMatchObject({ ok: false, error: { code: 'game-read-failed' } });
  });
});
