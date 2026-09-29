# `@forgeax/editor-game-plugins`

供 Edit host 使用的 asset-resident game plugin 适配器。

本包通过 `/api/files/tree` 发现当前游戏的插件，并负责共享的模块加载、注册事实和
producer 契约。Engine 的 `@forgeax/engine-app` 负责 App、World 与 Cordis 插件生命周期。

本包不依赖 `@forgeax/editor-core`，不会穿透 Play host 的 VAG 协议边界。独立 Play
在自己的浏览器 realm 中使用 Vite 生成的模块 manifest；两条发现路径都调用本包的
loader，共用组件与 system 注册策略。

共享的 `editorComponentVocabularyPlugin()` 是 Edit/Play 组合边界上的最小注册配置，负责
在场景物化前注册序列化结构组件（`Entity`、`Disabled`、`ParticleEffectPlayer`）。可选能力
插件（例如 `skinningPlugin()`）仍由各宿主在组合边界显式接入。

> [!IMPORTANT]
> 若保存的 `SceneAsset` 含游戏自定义组件，拥有该组件的默认 Cordis 插件须声明
> `beforeScene: true`，并仅使用场景物化前已就绪的服务注册组件；样例 Rotator 插件就是
> 这一用法。Edit 和 Play 会先激活这类插件，再实例化场景。其余游戏插件在场景存在后
> 激活，可以读取 `gameHost.defaultSceneRoot`。仅导入模块不会在新 World 中注册组件。
