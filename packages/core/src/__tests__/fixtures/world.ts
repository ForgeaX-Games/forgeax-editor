import { Disabled, Entity, World, type Component } from '@forgeax/engine-ecs';
import { ChildOf, Children, Name, Transform } from '@forgeax/engine-scene';
import { SceneInstance, Visibility } from '@forgeax/engine-render';
import { AnimationPlayer } from '@forgeax/engine-animation';

/**
 * Build an isolated ECS world with the engine tokens used by core scene tests.
 * Component definitions are deliberately registered per World: the editor
 * schema and scene owners must never depend on a process-global catalog.
 */
export function createCoreTestWorld(extra: readonly Component[] = []): World {
  const world = new World();
  const components: readonly Component[] = [
    Entity, Disabled,
    ChildOf, Children, Name, Transform,
    SceneInstance, Visibility, AnimationPlayer,
    ...extra,
  ];
  for (const component of components) world.components.register(component);
  return world;
}
