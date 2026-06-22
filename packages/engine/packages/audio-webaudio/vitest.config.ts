import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/engine-audio-webaudio',
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
    },
  },
});