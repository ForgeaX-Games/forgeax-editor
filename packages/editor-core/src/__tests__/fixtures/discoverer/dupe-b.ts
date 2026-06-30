// w17 fixture: defines Health component — will conflict with dupe-a.ts
import { defineComponent } from '@forgeax/engine-ecs';

export const HealthDupB = defineComponent('Health', {
  current: 'f32',
  armor: 'f32',
});
