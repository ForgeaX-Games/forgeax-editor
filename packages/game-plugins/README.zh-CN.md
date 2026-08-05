# `@forgeax/editor-game-plugins`

供 Edit host 使用的 asset-resident game plugin 适配器。

本包只负责编辑器特有的发现逻辑：通过 `/api/files/tree` 扫描当前游戏的
`assets/`，并解析稳定的插件导入 URL。运行时策略由
`@forgeax/engine-app` 统一负责：导入每个模块、计算 ECS registry 增量、返回
统一的加载/错误契约，并把注册的 system 挂到全新的 Play `World`。

本包不依赖 `@forgeax/editor-core`，不会穿透 Play host 的 VAG 协议边界。独立 Play
在自己的浏览器 realm 中使用 Vite 生成的模块 manifest；两条发现路径都调用同一个
`@forgeax/engine-app` loader，因此共享 engine 所有的组件与 system 注册策略，而不共享
host 适配器。
