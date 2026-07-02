// w18 fixture: normal script among broken ones
import { defineComponent, defineSystem } from '@forgeax/engine-ecs';

export const Stamina = defineComponent('Stamina', {
  current: 'f32',
  max: 'f32',
});

export const Regen = defineSystem({
  name: 'Regen',
  queries: [],
  labels: [],
  fn() {
    // gameplay system — no-op for fixture
  },
});
