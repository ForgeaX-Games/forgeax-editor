// Gateway scene read model — R0-02A / P1,P2,P8.
//
// This is the public, serializable projection of the persistence-owned scene
// manifest. The manifest remains the only source of scene identity; UI hooks
// and AI Gateway callers consume this same shape. `guid: null` is retained for
// the legacy single-scene path, where no multi-scene manifest entry exists.

export interface SceneReadModelEntry {
  readonly id: string;
  readonly name: string;
  readonly pack: string;
  /** Stable scene-asset identity from the pack envelope, when available. */
  readonly guid: string | null;
  readonly isCurrent: boolean;
  readonly isDefault: boolean;
}

export interface SceneReadModelReference {
  readonly id: string | null;
  readonly guid: string | null;
}

export interface SceneReadModel {
  /** Active game slug; null means the editor has no game session yet. */
  readonly gameId: string | null;
  /** The scene this edit window currently has open, if one is bound. */
  readonly currentScene: SceneReadModelReference | null;
  /** The game's forge.json defaultScene identity, if declared. */
  readonly defaultScene: SceneReadModelReference | null;
  readonly scenes: readonly SceneReadModelEntry[];
}

export const EMPTY_SCENE_READ_MODEL: SceneReadModel = Object.freeze({
  gameId: null,
  currentScene: null,
  defaultScene: null,
  scenes: Object.freeze([]),
});
