// w17 fixture: defines Health component — will conflict with dupe-a.ts
import { defineComponent } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';

export const HealthDupB = defineComponent('Health', {
  current: 'f32',
  armor: 'f32',
});

const plugin: Plugin = {
  name: 'fixture-dupe-b',
  inject: ['world'],
  apply(ctx) {
    const lease = ctx.world.components.register(HealthDupB);
    if (!lease.ok) throw lease.error;
  },
};
export default plugin;
