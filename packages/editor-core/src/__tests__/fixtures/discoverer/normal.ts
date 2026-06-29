// w18 fixture: normal script among broken ones
import { defineComponent, defineSystem, World } from '@forgeax/engine-ecs';

export const Stamina = defineComponent('Stamina', {
  current: 'f32',
  max: 'f32',
});

export const Regen = defineSystem({
  name: 'Regen',
  queries: [],
  labels: [],
  fn(_world: World, _results: never[], _commands: never) {
    // gameplay system — no-op for fixture
  },
});
