import type { BrowserGameRuntimePort } from './browser-game-runtime-port';

export interface ProductHostAdapter {
  readonly runtime: BrowserGameRuntimePort;
  readonly availability: () => ReturnType<BrowserGameRuntimePort['availability']>;
  readonly dispose: () => Promise<void>;
}

export function createProductHostAdapter(input: {
  readonly runtime: BrowserGameRuntimePort;
  readonly onDispose?: () => void | Promise<void>;
}): ProductHostAdapter {
  return {
    runtime: input.runtime,
    availability: () => input.runtime.availability(),
    async dispose() {
      await input.runtime.dispose();
      await input.onDispose?.();
    },
  };
}
