// w16 fixture: defines Movement system (gameplay, no render/transform label)
import { defineSystem } from '@forgeax/engine-ecs';
import { Update } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';

export const Movement = defineSystem({
  name: 'Movement',
  queries: [],
  fn() {
    // gameplay system — no-op for fixture
  },
});

const plugin: Plugin = {
  name: 'fixture-movement',
  inject: ['world'],
  apply(ctx) {
    ctx.world.addSystem(Update, Movement).unwrap();
  },
};
export default plugin;
