// w17 fixture: defines Health component — will conflict with dupe-b.ts
import { defineComponent } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';

export const HealthDupA = defineComponent('Health', {
  current: 'f32',
  regen: 'f32',
});

const plugin: Plugin = {
  name: 'fixture-dupe-a',
  inject: ['world'],
  apply(ctx) {
    const lease = ctx.world.components.register(HealthDupA);
    if (!lease.ok) throw lease.error;
  },
};
export default plugin;
