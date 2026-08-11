import type { ExecutionBootstrapEntry } from '@forgeax/engine-app';
import { runSample } from './main';

/** Thin realm entry: the Editor wrapper still owns VFX, physics, plugins, and lifecycle. */
const execution: ExecutionBootstrapEntry = async () => ({
  run: async (context) => runSample(context.world, {
    assets: context.assets,
    aspect: 16 / 9,
  }),
});

export default execution;
