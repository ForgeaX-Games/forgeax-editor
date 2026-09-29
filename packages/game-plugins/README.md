# `@forgeax/editor-game-plugins`

Edit-host adapter for asset-resident game plugins.

This package discovers the selected game's plugins through `/api/files/tree` and
owns the shared module load, registration facts, and producer contract. Engine
`@forgeax/engine-app` owns the App, World, and Cordis plugin lifecycle.

The package does not depend on `@forgeax/editor-core`, so it does not cross the
Play host's VAG protocol boundary. Standalone Play owns a Vite-generated module
manifest in its separate browser realm; both discovery paths call this package's
loader and use the same component and system registration policy.

The shared `editorComponentVocabularyPlugin()` is the small Edit/Play
composition profile for serialized structural components (`Entity`, `Disabled`,
and `ParticleEffectPlayer`). Hosts install it before scene materialization;
optional feature plugins such as `skinningPlugin()` remain explicit at the host
boundary.

> [!IMPORTANT]
> If a saved `SceneAsset` contains a game-defined component, its owning default
> Cordis plugin must declare `beforeScene: true` and register that component from
> services available before scene materialization, as the sample Rotator plugin
> does. Edit and Play activate these plugins before instantiation. Other game
> plugins activate after the scene exists and may use `gameHost.defaultSceneRoot`.
> Importing a module alone does not register its components in a fresh World.
