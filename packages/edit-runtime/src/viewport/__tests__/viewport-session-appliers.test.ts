import { afterEach, describe, expect, it } from 'bun:test';
import { gateway } from '@forgeax/editor-core';
import { registerViewportSessionAppliers } from '../viewport-session-appliers';

const registered: Array<() => void> = [];
afterEach(() => { for (const dispose of registered.splice(0)) dispose(); });

function deps() {
  const calls: string[] = [];
  const world = {
    addSystem: () => ({ unwrap: () => { calls.push('addSystem'); } }),
    removeSystem: () => ({ unwrap: () => { calls.push('removeSystem'); } }),
  } as never;
  return {
    calls,
    value: {
      play: () => { calls.push('play'); },
      stop: () => { calls.push('stop'); },
      setDisplay: (display: 'scene' | 'game') => { calls.push(`display:${display}`); },
      grantGameControl: () => { calls.push('grant'); },
      releaseGameControl: () => { calls.push('release'); },
      world,
    },
  };
}

describe('viewport session applier registrar (M3)', () => {
  it('registers all seven operations and routes calls to runtime deps', () => {
    const d = deps();
    registered.push(registerViewportSessionAppliers(d.value));
    expect(gateway.dispatch({ kind: 'play' })).toEqual({ ok: true });
    expect(gateway.dispatch({ kind: 'stop' })).toEqual({ ok: true });
    expect(gateway.dispatch({ kind: 'setDisplay', display: 'game' })).toEqual({ ok: true });
    expect(gateway.dispatch({ kind: 'grantGameControl' })).toEqual({ ok: true });
    expect(gateway.dispatch({ kind: 'releaseGameControl' })).toEqual({ ok: true });
    expect(gateway.dispatch({ kind: 'addSystem', name: '' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    expect(gateway.dispatch({ kind: 'removeSystem', name: 'test-system' })).toEqual({ ok: true });
    expect(d.calls).toEqual(['play', 'stop', 'display:game', 'grant', 'release', 'removeSystem']);
  });

  it('validates display/name, rejects duplicate registration, and disposes idempotently', () => {
    const first = registerViewportSessionAppliers(deps().value);
    expect(() => registerViewportSessionAppliers(deps().value)).toThrow();
    expect(gateway.dispatch({ kind: 'setDisplay', display: 'bad' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    first();
    first();
    expect(gateway.dispatch({ kind: 'play' })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_OP' } });
  });
});
