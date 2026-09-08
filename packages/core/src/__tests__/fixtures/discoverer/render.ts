// w16 fixture: defines Render system (structure/presentation, has render label)
import { defineSystem } from '@forgeax/engine-ecs';
import { Update } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';

export const Render = defineSystem({
  name: 'Render',
  queries: [],
  fn() {
    // structure system — no-op for fixture
  },
});

const plugin: Plugin = {
  name: 'fixture-render',
  inject: ['world'],
  apply(ctx) {
    ctx.world.addSystem(Update, Render).unwrap();
  },
};
export default plugin;
