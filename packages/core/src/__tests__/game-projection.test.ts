// Game-owned Play projection — the Gateway may discover/invoke/read only what
// bootstrap registered for the active fresh play World. No action creates an
// authoring command, undo entry, or ledger record.

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';

function makeGateway(): EditGateway {
  const doc = createEditSession();
  doc.world = new World();
  return new EditGateway(doc);
}

describe('game-owned Play projection', () => {
  it('is invisible in Edit, discovers game-owned descriptors in Play, and never writes the authoring ledger', async () => {
    const gateway = makeGateway();
    const registry = gateway.createGameProjectionRegistry();
    let level = 'a';

    registry.registrar.registerAction({
      id: 'test.level.transition',
      title: 'Transition test level',
      argsSchema: {
        type: 'object',
        properties: { target: { type: 'string', enum: ['a', 'b'] } },
        required: ['target'],
      },
      run: (args) => { level = (args as { target: string }).target; },
    });
    registry.registrar.registerRead({
      id: 'test.level.status',
      title: 'Read test level',
      read: () => ({ activeLevel: level, roots: level === 'a' ? 1 : 2 }),
    });

    expect(gateway.listGameActions()).toEqual([]);
    expect(gateway.listGameReads()).toEqual([]);
    await expect(gateway.invokeGameAction('test.level.transition', { target: 'b' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'game-projection-unavailable' } });

    gateway.enterPlay(new World());
    gateway.installGameProjection(registry);

    expect(gateway.listGameActions()).toEqual([{
      id: 'test.level.transition',
      title: 'Transition test level',
      argsSchema: {
        type: 'object',
        properties: { target: { type: 'string', enum: ['a', 'b'] } },
        required: ['target'],
      },
    }]);
    expect(gateway.listGameReads()).toEqual([{
      id: 'test.level.status',
      title: 'Read test level',
    }]);

    await expect(gateway.invokeGameAction('test.level.transition', { target: 'b' }))
      .resolves.toEqual({ ok: true, value: undefined });
    await expect(gateway.readGameState('test.level.status'))
      .resolves.toEqual({ ok: true, value: { activeLevel: 'b', roots: 2 } });
    expect(gateway.ledger).toEqual([]);
    expect(gateway.canUndo()).toBe(false);
  });

  it('returns structured validation, unknown-ID, callback, and serializability failures', async () => {
    const gateway = makeGateway();
    const registry = gateway.createGameProjectionRegistry();
    registry.registrar.registerAction({
      id: 'test.action',
      title: 'Test action',
      argsSchema: { type: 'object', required: ['value'], properties: { value: { type: 'number' } } },
      run: () => { throw new Error('game rejected transition'); },
    });
    registry.registrar.registerRead({
      id: 'test.bad-read',
      title: 'Bad read',
      read: () => new Map() as never,
    });
    gateway.enterPlay(new World());
    gateway.installGameProjection(registry);

    await expect(gateway.invokeGameAction('test.action', {}))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    await expect(gateway.invokeGameAction('missing', {}))
      .resolves.toMatchObject({ ok: false, error: { code: 'unknown-game-projection' } });
    await expect(gateway.invokeGameAction('test.action', { value: 1 }))
      .resolves.toMatchObject({ ok: false, error: { code: 'game-action-failed', hint: expect.stringContaining('game rejected transition') } });
    await expect(gateway.readGameState('test.bad-read'))
      .resolves.toMatchObject({ ok: false, error: { code: 'game-read-failed' } });
  });

  it('clears all closures on Stop and rejects stale calls', async () => {
    const gateway = makeGateway();
    const registry = gateway.createGameProjectionRegistry();
    registry.registrar.registerAction({ id: 'test.once', title: 'Once', run: () => {} });
    registry.registrar.registerRead({ id: 'test.read', title: 'Read', read: () => 'live' });
    gateway.enterPlay(new World());
    gateway.installGameProjection(registry);

    gateway.exitPlay();

    expect(gateway.listGameActions()).toEqual([]);
    expect(gateway.listGameReads()).toEqual([]);
    await expect(gateway.invokeGameAction('test.once', null))
      .resolves.toMatchObject({ ok: false, error: { code: 'game-projection-unavailable' } });
    await expect(gateway.readGameState('test.read'))
      .resolves.toMatchObject({ ok: false, error: { code: 'game-projection-unavailable' } });
  });
});
