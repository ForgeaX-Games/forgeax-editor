# 编辑器 collapse 回归调研 + 修复记录(打开 game-default 一连串问题)

**日期**: 2026-07-03
**触发**: 用 standalone 编辑器加载 `game-default`(`bun run start --game <dir>`)后浏览器一堆报错 + 场景空 + Play/Stop 异常。
**性质**: 大多是 **M7 editor-collapse(engine commit `2d99456` / editor #22)的回归**——editor 授权词汇坍缩为 engine-native 组件时,加载/快照/Play-Stop 路径重写留下的缺陷;最后逐层剥出 **12 个** bug,其中 #12 是更深的 **引擎缺口**(非 editor 回归)。
**方法**: systematic-debugging,每个 bug 都 playwright 实测复现 + 定位根因(file:line),不猜。

**结论速览**:
- **#1-#4**: 已合入 editor main(PR #29)。
- **#5-#11**: 本批已 commit(editor 分支 `fix/collapse-load-play-regressions` + assets 分支 `fix/sky-meta-equirect-kind`),全部 e2e 验证。含**最严重的 #11 场景存盘毁数据 guard**。
- **#12**: 引擎 collect 上行 round-trip 缺口,已写 engine feedback,阻塞 "Add SceneAsset to Scene"。
- **#6c**: engine 模板 cylinder builtin 迁移,待 engine worktree。

---

## 关键背景(collapse 后的加载模型)

- 编辑器加载场景应走引擎规范:`AssetRegistry.loadByGuid<SceneAsset>(sceneGuid)` → `allocSharedRef` → `registry.instantiate(handle, world)`(和游戏 `main.ts` 同一条),`_resolveSceneGuids` 负责 GUID→u32 handle mint。
- 编辑器 session 的实体映射 `_e2h`/`_h2e`(`editor-core/src/entity-state.ts`)是 localId↔engine-handle 的 SSOT;hierarchy/selection/save 都读它。
- popout 面板(`ep:*` iframe)通过 BroadcastChannel snapshot 重建视图,world 是 inert(dead-world → 走 popout cache)。
- `game-default` 场景资产:mesh 用 engine builtin(cube `cbe42beb` / sphere `95730fd2` / cylinder builtin `ab20af21`);材质是 **scene.pack.json `assets[]` 内联的真 pack 资产**;天空 HDR(equirect `81eec382`)在 **`forgeax-editor-assets/template-game-default/sky.hdr`**(editor assets submodule,play-runtime 经 symlink 共享)。

---

## 12 个 bug + 根因 + 修复状态

> 标注约定:`已合入 PR #29` = 早前已进 main;`本批已 commit` = 本次分支已提交;`引擎缺口` = 待 engine 补。

### ✅ #1 SharedRefReleasedError(已修 + 已合入 editor main `3376563` via PR #29)
**症状**: 加载时 `[World.write (MeshFilter.assetHandle shared scalar retain)] SharedRefReleasedError`(handle cbe42beb / 81eec382)。
**根因**: 旧 `loadWorldFromPack`(`editor-core/src/store.ts`)把带 **GUID 字符串**的 SceneAsset 直接喂 `world.instantiateScene`;`as number` 运行时擦除,字符串写进 Uint32 列变 0 → retain 报"已释放"(实为"从未 alloc")。绕过了引擎的 GUID→handle mint。
**修复**: 新 `loadSceneByGuid` 走引擎规范 `loadByGuid → registry.instantiate`。删手搓 `resolveRefsInComponents`。

### ✅ #2 unknown component 'Mesh'/'Material'/'Light' dropped(已修 + PR #29)
**根因**: `loadWorldFromPack` 加载后**没填 `_e2h`** → `main.tsx` 的 `entIds(doc).length===0` 永真 → 误触发 `seed()` 兜底 → `seed()` 用**旧词汇**(Mesh/Material/Light + Transform x/y/z)被 `spawnComponentData` drop。
**修复**: (a) `loadSceneByGuid` 从 `SceneInstance.mapping`(localId→handle Uint32Array)重填 `_e2h`;(b) `seed()` 迁移 engine-native(MeshFilter{assetHandle: HANDLE_CUBE/SPHERE/CYLINDER} + DirectionalLight + posX/Y/Z,丢 Collider)。

### ✅ #3 BroadcastChannel postMessage 'toSchemaJSON could not be cloned'(已修 + PR #29)
**根因**: collapse 把活引擎 World 注入 `bus.doc.world`;`buildSnapshot` 把整个 `bus.doc` 塞进 snapshot → structuredClone 遍历 World archetype graph 的 Component token 的 `toSchemaJSON()` 方法(函数不可克隆)。
**修复**: `buildSnapshot` 发 **world-less doc**(`{world:null, registry:null}`);popout `reviveSession` 见 null world 就保持 inert(走 worldState popout cache)。

### ✅ #4 场景加载时序 + h===0(已修 + PR #29)
**根因**: `loadDocFromDisk` 在 boot 早期跑(`bus.doc.world`/`registry` 还没注入到 renderer 的)→ 加载进临时 world 后被世界交换丢弃。另 `loadSceneByGuid` 里 `h===0` 被错误跳过(handle 0 是有效实体 Ground)。
**修复**: 把场景加载移到 world/registry 注入之后(main.tsx,+`renderer.ready` await);`h===0` 不跳过。

### ✅ #5 childrenOf 崩溃 + hierarchy 空(已修,**本批已 commit**,e2e 已验)
**症状**: `document.ts:343 Cannot read properties of null (reading 'get')` at `childrenOf` → Hierarchy 面板渲染失败 → 空。
**根因**: #3 让 popout 的 `doc.world = null`,但 `childrenOf`(`editor-core/src/document.ts`)直接 `doc.world.get(...)` → popout 崩。#3 只改了 entity-state 的读,漏了 childrenOf。
**修复**: `childrenOf` 加 dead-world 分支——popout 走 `entIds`+`entParent`(dead-world-aware,读 popout cache)派生 children;导出 `entIsDeadWorld`。e2e 实测:hierarchy 列出 Ground/Sun/TreeTrunk/... 无崩溃。

### ✅ #6 资产管线缺口(sky + cylinder)(editor 侧**本批已 commit**;engine 侧 cylinder = #6c 待做)
**根因**(纠正了最初"材质运行时生成不落盘"的误判——材质其实在 scene.pack 内联,是真 pack 资产):
1. **sky 不在编辑器 catalog**: play-runtime 有 `sharedAssetRoots()` 把 `shared-assets`(→forgeax-editor-assets)纳入 pluginPack;编辑器 `gamePackRoots()` 只有 `<game>/assets`+`scenes`,**漏 shared-assets** → equirect `81eec382` 不在 pack-index。
2. **sky meta kind 错**: `forgeax-editor-assets/template-game-default/sky.hdr.meta.json` 的 subAsset `kind: "image"`,但 engine 的对应文件(`forgeax-engine-assets/demo-assets/...`)是 `kind: "equirect"`——**两个 assets submodule 分叉**,editor 那份是错的。
3. **cylinder 未迁移 builtin**: scene.pack 的圆柱 ref 还用旧手搓 GUID `c1111111`(Play 靠 main.ts 运行时 `assets.catalog` 兜住,编辑器不跑 main.ts)。应迁移到 engine builtin `ab20af21`。
**修复**: (a) editor `vite.config.ts` 加 `sharedTemplateRoots()`(指 `forgeax-editor-assets/template-game-default`);(b) editor assets 的 sky meta 对齐 engine 版(kind→equirect);(c) **待做**:engine 模板 scene.pack cylinder GUID `c1111111`→`ab20af21` + main.ts 去掉运行时 cylinder catalog。
**验证**: 编辑器 pack-index 现 15 条目、sky+材质 FOUND;scratch 里手动 swap cylinder 后 `_e2h=23`(完整场景加载,DIAG `scene OK entities=23`)。

### ✅ #7 Stop 快照根用错 world(已修,**本批已 commit**)
**根因**: run-lifecycle 的 `playSimulation` 用 `getDefaultSceneRoot()` 快照场景;但 `defaultSceneRoot`(main.tsx)只由 **`openProject`** 设置——而 openProject 实例化进它**自己的 throwaway `new World()`**,root 在另一个 world → `getSceneInstanceState(defaultSceneRoot)` 对 live world 失败 → snapshot 没捕获 → Stop 无法恢复。
**修复**: 导出 `getLoadedSceneRoot()`(=`loadSceneByGuid` 设的 `currentSceneRoot`,live-world 根);main.tsx 加载后 `defaultSceneRoot = getLoadedSceneRoot()`;移除 openProject 对 defaultSceneRoot 的 clobber(它只作 proof-of-life)。

---

### ✅ #8 Stop 重建后 `_e2h` 未重填 + despawn 顺序错(已修,**本批已 commit**,e2e 已验)
**根因(两层)**:
1. **`_e2h` 未重填**: `run-lifecycle.ts` Stop 用 `despawnScene(snapshotRoot)` + `instantiateScene(snapshotSource)` 重建场景 → **产生新 handle + 新场景根**,但没重填编辑器的 `_e2h`/`_h2e`,也没更新 `currentSceneRoot`/`defaultSceneRoot` → 编辑器指向已销毁的旧 handle → 场景"没复原"。旧代码 `bus.replaceDoc(cloneEditSession)` 保持同步,M4 collapse 换成 despawn+re-instantiate 漏了重填。
2. **despawn 顺序错(更致命)**: `despawnRuntimeSpawns()`(清理 Play 期间生成的子弹/敌人 = pre▶→now handle diff)**跑在 re-instantiate 之后** → 重建出的新场景 handle(正确地)不在 `prePlayEntities` 里 → 被当成"运行时 spawn"全部 despawn → **刚复原的场景又被扫掉**。
**修复**: (a) editor-core/store.ts 抽 `populateSessionMapFromSceneRoot(root)`(SSOT,`loadSceneByGuid` 与 rebind 共用)+ 导出 `rebindLoadedScene(newRoot)`(重填 `_e2h`+fire docListeners);(b) run-lifecycle 加 DI `rebindSceneInstance` 回调,且把 `despawnRuntimeSpawns()` 移到 re-instantiate **之前**;(c) main.tsx wire 回调 → `rebindLoadedScene` + 重绑 `defaultSceneRoot`。
**验证**: `bun -F @forgeax/editor-edit-runtime test`(新增 AC-06 两测:despawn 顺序 + rebind onto new root,10/10 绿);**e2e**(`e2e/scripts/probe-stop-restore.mjs` 经 :15290 真开编辑器)—— `scene ▸ loaded entities=23 root=23` → Play → Stop → `scene ▸ restored entities=23 root=16777216`(23 实体完整复原、新 root、无 collapse 报错)。

---

### ✅ #9 鼠标左键射击失效(F 键能射)(已修,**本批已 commit**,e2e 已验)
**隔离**: Play 下 F 键能发子弹、鼠标左键不行;WASD 移动/物理/相机正常。射击绑两个输入(main.ts:693 `keys['KeyF'] || wantShoot`);F 走 `window` keydown(层无关,OK),鼠标走 `canvas.addEventListener('click'/'mousedown', ...)`。
**根因(已定,hit-test 实证)**: 编辑器 `index.html` 的 `#ui`(全屏 overlay,`position:fixed; inset:0`)默认 **`pointer-events:auto`**,盖在引擎 canvas(`#app`)之上,**吞掉所有 viewport 点击** → game canvas 的 click/mousedown 监听永不触发。`document.elementFromPoint(中心)` 返回 `DIV#ui` 而非 `CANVAS`。本仓已有正确范式(`.ed-overlay`:容器 `pe:none` + 交互子元素各自 `pe:auto`),但真正的 `#ui` root 没遵守。
**修复**: `#ui { pointer-events: none }`(index.html);其交互 chrome(`vp-bar`/`vp-hints`/`vp-clip`/GameOverlay/popout-tray/boot+error overlay)本就各自 `pe:auto`,空白区现在把点击透传给 canvas。**一行 CSS**,零 JS 改动。
**验证**: `e2e/scripts/probe-mouse-shoot.mjs`(:15290 真开)—— 中心 hit-test target 从 `DIV#ui` 变 `CANVAS`;Play 后真实左键点击 canvas → `world.inspect().entityCount` 53→54(子弹实体已 spawn)。

---

### ✅ #10 选中 entity → Inspector popout 崩溃(dead-world,#5 同类)(已修,**本批已 commit**,e2e 已验)
**症状**: `Inspector.tsx:276 Uncaught TypeError: Cannot read properties of null (reading 'get')`(commitHookEffectListMount 内,即选中后的 useEffect)。
**根因**: 与 #5 childrenOf **完全同类** —— Inspector 选中时的 useEffect 直接 `bus.doc.world.get(handle, Transform)` 读四元数转 euler。popout 窗口里 `bus.doc.world = null`(#3 snapshot revive 保持 inert)→ NPE。#3/#5 修了 childrenOf/entity-state 的读,但漏了 Inspector 这处直读。
**修复**: 改用 `entComponent(bus.doc, sel, 'Transform')`(dead-world-aware SSOT 读取器,popout 读 cache、main 读 live world)—— 与 childrenOf 修法一致。顺带删掉此文件里已无用的 `entHandle` + engine `Transform` import。
**验证**: `e2e/scripts/probe-inspector-select.mjs`(:15290 真开)—— Hierarchy popout 点 RedBox → null-get 崩溃计数 0→0、Inspector popout 正常渲染选中实体(Transform/name 可见)。

> [!NOTE]
> **教训**: `bus.doc.world` 直读是 popout 崩溃的复发源(#5 childrenOf、#10 Inspector 已中招)。任何在 panel/popout 组件里 `bus.doc.world.xxx` 的直读都要换成 dead-world-aware 的 `ent*` 读取器。**待清查**:全仓 grep `bus.doc.world` / `doc.world.` 在 editor-panels 里的其它直读点,一次扫清同类隐患。

---

### ✅ #11 加载/操作场景 → scene.pack.json 被写成 0 字节(数据丢失,**最严重**)(已修,**本批已 commit**)
**症状**: 反复出现 —— 加载场景、Play/Stop、或"把 City_Sample_512 加入场景"后,磁盘上的 `scene.pack.json`(以及有时根目录多出一个)变成 **0 字节**,场景彻底丢失、下次打开空白。
**根因(代码实证)**: `serializedPack()`(store.ts)= `worldToPack(bus.doc, ...) ?? ''` —— **序列化失败时返回空字符串**。`worldToPack` 在 world/registry 缺失、或引擎 `rootsToSceneAsset`/`serializeSceneAssetToPack` 报错(某个 spawn/import 进来的实体带了 pack 序列化器无法持久化的组件)时返回 `null` → `?? ''` → **空串**。两条写盘路径都会把这个空串盖到真场景上:
  1. `saveDocToDisk`(手动 Save)
  2. `flushPendingSaveBeacon`(pagehide / visibilitychange / mode-switch **静默** sendBeacon)—— 这条最阴,不点 Save 也会触发,加了脏东西后一切页面卸载/切换即毁盘。
**修复**: `serializedPack()` 返回 `string | null`(失败传播 null,不再 `?? ''`);两条写盘路径都先取值、`=== null` 即 **abort 写盘**(保留 `_isDirty` 待下次重试)+ error 日志。**失败的 save 绝不覆盖好数据**(AGENTS.md #2:authoring 必须 round-trip,否则是数据丢失 bug)。
**状态**: 核按构造成立(唯一能写空的 `?? ''` 已在两处消除,typecheck 强制 null 处理);514 editor-core 测试全绿。数据丢失 guard 是对的、必须留 —— 但**根因不在 editor**(见 #12)。

---

### 🔬 #12 真根因:引擎 collect 不支持嵌套 SceneInstance → mount 上行 round-trip(**引擎缺口**,已写 feedback)
**触发链**: 用户操作 = "把一个 SceneAsset(city_Sample_512 的 scene sub-asset)add 进当前场景"。正确路径应是 `registry.loadByGuid(sceneGuid) → instantiateScene(handle, parent=当前场景根)`,产出一个**嵌套 SceneInstance**。但一旦 save,`rootsToSceneAsset` 把该嵌套 SceneInstance 的 synthetic-root 当普通实体遍历 → 吐出带**失效 mapping** 的 `SceneInstance` 组件(而非引擎 pack 期望的 `mount`)→ 序列化失败 → `worldToPack` 返回 null → (旧 `?? ''`)写 0 字节。**#11 的毁盘只是这个引擎缺口的下游放大。**
**源码坐实(engine 仓,逐条 grep)**:
- 下行 `instantiateScene` mount 展开完整 + 有测(`asset-registry-mounts.test.ts` 等);
- **上行 `collect-scene-asset.ts` 完全没有 mount/SceneInstance 处理**(`mount`/`SceneInstance`/`memberFirst` 一个词都没有,唯一命中是第 1 行注释);
- **没有一个测试**同时涉及 `rootsToSceneAsset` + `mount` —— 上行 round-trip 从未被测(所以缺口一直藏着);
- 修复入口已存在:`world.ts:4391 getSceneAssetForInstance(root)`。
**处置**: 已写 engine feedback `forgeax-engine/.forgeax-harness/feedbacks/2026-07-03-nested-sceneinstance-not-collected-to-mount.md`(domain `engine-ecs`,severity major,lint 通过)。修法 = collect 遇带 SceneInstance 的实体折叠成 mount(用 getSceneAssetForInstance)+ 必附 round-trip 测试 + overrides 保真。**这是 engine feature 补全,走 engine 闭环。**
**editor 侧连带**: 正确的 "Add SceneAsset to Scene"(纯 `loadByGuid + instantiateScene` 嵌套,按 GUID 不按 meta.json)**阻塞于此引擎缺口**。此前我在改的后端 `/api/assets/import-scene`(重解析 GLB 逐实体 spawn)是**错路,已全部 revert**(违反 AGENTS.md #1/#3:手搓引擎已有能力 / 输出 sidecar 而非 scene)。

---

## ⏳ 未修 / 阻塞

- **#12 引擎缺口**(阻塞 Add-SceneAsset-to-Scene):引擎 collect 上行 round-trip,已记 feedback,待 engine 闭环补齐。
- **#6c**: engine 模板 scene.pack cylinder `c1111111`→`ab20af21` builtin + main.ts 去运行时 catalog(engine 侧,需 worktree)。
- 其余 #1-#11 editor 侧全部修复并 e2e 验证。

## 已落地清单

**已合入 editor main `3376563`(PR #29)**: #1 #2 #3 #4。
**本批已 commit(分支 `fix/collapse-load-play-regressions`)**:
- editor: `vite.config.ts`(shared root #6a)、`document.ts`(childrenOf #5)、`entity-state.ts`(entIsDeadWorld 导出 #5)、`store.ts`(getLoadedSceneRoot #7 + `populateSessionMapFromSceneRoot`/`rebindLoadedScene` #8 + **serializedPack null guard #11**)、`editor-core/index.ts`+`editor-shared/index.ts`(导出 rebindLoadedScene + entIsDeadWorld)、`main.tsx`(defaultSceneRoot rewire #7 + rebindSceneInstance wire + scene 面包屑 #8)、`engine/run-lifecycle.ts`(despawn 顺序 + rebind DI #8)、`engine/__tests__/run-lifecycle-roundtrip.test.ts`(修陈旧 replaceDoc 断言 + AC-06 两测 #8)、`index.html`(`#ui` pointer-events:none #9)、`editor-panels/Inspector.tsx`(entComponent 读 Transform #10)、`editor-panels/Material.tsx`(dead-world guard #10)、`e2e/scripts/probe-{stop-restore,mouse-shoot,inspector-select,city-import-noclobber}.mjs`(e2e 探针,新文件)。
- `forgeax-editor-assets`(分支 `fix/sky-meta-equirect-kind`): `template-game-default/sky.hdr.meta.json`(kind→equirect #6b)。

**scratch 备份机制**: `.forgeax-scratch/game-default/` 内建独立嵌套 git 仓(外层 gitignore,互不干扰),已 commit clean baseline(23 实体、cylinder builtin,无 city 导入残留)。编辑器写坏场景后一行复原:`git -C .forgeax-scratch/game-default checkout .`。

**待做**:
- #12 引擎 collect 上行(阻塞 Add-SceneAsset,已记 engine feedback)。
- #6c engine 模板 cylinder builtin 迁移(engine worktree)。
- (清理) edit-runtime 4 个陈旧 test 文件 import 已删模块(`test/{anim,matgraph,sync-channel,dock-tree}.test.ts`)—— pre-existing,非本次回归,可顺手删。

## 验证要点(每个都需真开编辑器)
- playwright 抓 console:#1/#2/#3 三类报错清零;`_e2h.size`(23=完整场景,9=seed 兜底)。
- hierarchy iframe 列出实体(#5)。
- Play→Stop `_e2h` 稳定 + 实体 handle 仍存活(#8——size 不够,要验 handle 有效)。
- F 键 vs 鼠标射击(#9 隔离)。

## 跨仓提交序(自底向上)
engine(#6c cylinder)→ forgeax-editor-assets(#6b sky meta)→ editor(pin bump + 其余)。studio #225(fbx-wasm setup)在 editor 稳定后 re-pin 重开。
