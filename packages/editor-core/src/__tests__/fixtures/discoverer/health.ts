// w16 fixture: defines Health component
import { defineComponent } from '@forgeax/engine-ecs';

export const Health = defineComponent('Health', {
  current: 'f32',
  max: 'f32',
});
