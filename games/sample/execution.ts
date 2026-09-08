import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { runSample } from './main';

/** Thin realm entry: the Editor wrapper still owns VFX, physics, plugins, and lifecycle. */
interface SampleExecutionContext {
  readonly world: World;
  readonly assets: AssetRegistry;
}

type SampleExecution = (
  data: unknown,
) => Promise<{ run(context: SampleExecutionContext): void | Promise<void> }>;

const execution: SampleExecution = async (_data) => ({
  run: async (context) => runSample(context.world, {
    assets: context.assets,
    aspect: 16 / 9,
  }),
});

export default execution;
