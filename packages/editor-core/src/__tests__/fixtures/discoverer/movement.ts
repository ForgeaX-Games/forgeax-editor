// w16 fixture: defines Movement system (gameplay, no render/transform label)
import { defineSystem, World } from '@forgeax/engine-ecs';

export const Movement = defineSystem({
  name: 'Movement',
  queries: [],
  labels: [],
  fn(_world: World, _results: never[], _commands: never) {
    // gameplay system — no-op for fixture
  },
});
