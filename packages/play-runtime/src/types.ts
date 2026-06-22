import type { Renderer, AssetRegistry } from '@forgeax/engine-runtime';
import type { World, EntityHandle } from '@forgeax/engine-ecs';
import type { App, GameEntry as EngineGameEntry } from '@forgeax/engine-app';
import type { SceneAsset } from '@forgeax/engine-types';

export interface GameContext {
  readonly world: World;
  readonly renderer: Renderer;
  readonly assets: AssetRegistry;
  readonly app: App;
  registerUpdate(fn: (dt: number) => void): void;
  /** Synthetic root entity of the host-instantiated defaultScene. Carries the
   * SceneInstance component (mapping/state/source). Absent when the game has
   * no defaultScene in forge.json — games check for undefined before use. */
  readonly defaultSceneRoot?: EntityHandle;
  /** The loaded SceneAsset payload for the defaultScene. Contains the
   * author-side entity list (entities[]) with Name components — games use it
   * to resolve Name-to-localId before looking up the runtime Entity via
   * world.get(defaultSceneRoot, SceneInstance).value.mapping[localId].
   * Absent when the game has no defaultScene. */
  readonly defaultScene?: SceneAsset;
}

// D-3: GameEntry has been semantically downgraded from "total entry"
// (fetch + instantiate the scene itself) to a bootstrap hook that receives a
// world that already contains the defaultScene entities (instantiated by the
// host before entry runs). The game module wires HUD / inputs / custom
// systems — it no longer performs its own scene fetch + instantiate.
// Signature kept stable (C4 / OOS-3): export default start.
export type GameEntry = (ctx: GameContext) => void | Promise<void>;
export type { EngineGameEntry };
