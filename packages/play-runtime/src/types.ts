import type { Renderer, AssetRegistry } from '@forgeax/engine-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { App, GameEntry as EngineGameEntry } from '@forgeax/engine-app';

export interface GameContext {
  readonly world: World;
  readonly renderer: Renderer;
  readonly assets: AssetRegistry;
  readonly app: App;
  registerUpdate(fn: (dt: number) => void): void;
}

export type GameEntry = (ctx: GameContext) => void | Promise<void>;
export type { EngineGameEntry };
