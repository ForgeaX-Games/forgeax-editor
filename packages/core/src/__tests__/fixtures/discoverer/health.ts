// w16 fixture: defines Health component
import { defineComponent } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';

export const Health = defineComponent('Health', {
  current: 'f32',
  max: 'f32',
});

const plugin: Plugin = {
  name: 'fixture-health',
  inject: ['world'],
  apply(ctx) {
    const lease = ctx.world.components.register(Health);
    if (!lease.ok) throw lease.error;
  },
};
export default plugin;
