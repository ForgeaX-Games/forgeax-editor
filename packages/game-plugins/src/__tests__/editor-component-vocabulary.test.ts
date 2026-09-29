import { describe, expect, it } from 'bun:test';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { editorComponentVocabularyPlugin } from '../index';

describe('editor component vocabulary', () => {
  it('registers serialized structural tokens in the World-local catalog', async () => {
    const world = new World();
    const context = await createWorldContext(world, [editorComponentVocabularyPlugin()]);
    try {
      expect([...world.components.entries().keys()]).toEqual(
        expect.arrayContaining(['Entity', 'Disabled', 'ParticleEffectPlayer', 'RigidBody', 'Collider', 'CollidingEntities', 'CharacterController',
        ]),
      );
    } finally {
      await context.fiber.dispose();
    }
    expect(world.components.resolve('ParticleEffectPlayer')).toBeUndefined();
    expect(world.components.resolve('RigidBody')).toBeUndefined();
  });
});
