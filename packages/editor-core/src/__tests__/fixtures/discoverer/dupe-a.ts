// w17 fixture: defines Health component — will conflict with dupe-b.ts
import { defineComponent } from '@forgeax/engine-ecs';

export const HealthDupA = defineComponent('Health', {
  current: 'f32',
  regen: 'f32',
});
