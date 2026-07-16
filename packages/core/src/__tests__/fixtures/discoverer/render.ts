// w16 fixture: defines Render system (structure/presentation, has render label)
import { defineSystem } from '@forgeax/engine-ecs';

export const Render = defineSystem({
  name: 'Render',
  queries: [],
  fn() {
    // structure system — no-op for fixture
  },
});
