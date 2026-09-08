// w18 fixture: normal script among broken ones
import { defineComponent, defineSystem } from '@forgeax/engine-ecs';
import { Update } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';

export const Stamina = defineComponent('Stamina', {
  current: 'f32',
  max: 'f32',
});

export const Regen = defineSystem({
  name: 'Regen',
  queries: [],
  fn() {
    // gameplay system — no-op for fixture
  },
});

const plugin: Plugin = {
  name: 'fixture-normal',
  inject: ['world'],
  apply(ctx) {
    const lease = ctx.world.components.register(Stamina);
    if (!lease.ok) throw lease.error;
    ctx.world.addSystem(Update, Regen).unwrap();
  },
};
export default plugin;
