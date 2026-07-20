// w16 fixture: defines Movement system (gameplay, no render/transform label)
import { defineSystem } from '@forgeax/engine-ecs';

export const Movement = defineSystem({
  name: 'Movement',
  queries: [],
  fn() {
    // gameplay system — no-op for fixture
  },
});
