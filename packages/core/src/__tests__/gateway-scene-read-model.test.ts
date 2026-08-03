import { describe, expect, it } from 'bun:test';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';

describe('Gateway scene read model', () => {
  it('returns a structured empty model before a host binds persistence', () => {
    const gateway = new EditGateway(createEditSession());
    expect(gateway.sceneReadModel()).toEqual({
      gameId: null,
      currentScene: null,
      defaultScene: null,
      scenes: [],
    });
  });

  it('projects the bound provider without creating a second scene fact', () => {
    const gateway = new EditGateway(createEditSession());
    const model = {
      gameId: 'sample',
      currentScene: { id: 'main', guid: 'guid-main' },
      defaultScene: { id: 'main', guid: 'guid-main' },
      scenes: [{
        id: 'main', name: 'Main', pack: 'assets/main.pack.json', guid: 'guid-main',
        isCurrent: true, isDefault: true,
      }],
    } as const;
    const detach = gateway.registerSceneReadProvider(() => model);
    expect(gateway.sceneReadModel()).toBe(model);
    detach();
    expect(gateway.sceneReadModel().gameId).toBeNull();
  });
});
