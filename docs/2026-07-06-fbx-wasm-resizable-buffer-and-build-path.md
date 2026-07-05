# FBX 浏览器导入的 wasm 问题调研 + 修复记录（resizable-buffer / 构建路径 / importer 注册）

**日期**: 2026-07-06
**触发**: 验证 skin(Fox.glb) / fbx-skin(humanoid.fbx) 骨骼动画资产的「导入→加入场景→保存→重开」全流程时，FBX 导入在浏览器里 cook 直接失败；glTF 路径无碍。
**性质**: 三个独立根因，其中**一个是 engine wasm 工具链问题**（本文重点），另外两个是 editor 侧的构建路径 / importer 注册缺失。
**方法**: headless Chromium 实测复现 + 定位到 file:line + 用 monkeypatch 反证根因，不猜。

**结论速览**:
- **#1（engine wasm 根因，本文重点）**: emcc glue 用 resizable ArrayBuffer 后备 `HEAPU8`，`UTF8ToString` 内部的 `TextDecoder.decode` 被现代 Chromium 拒绝。→ forgeax-engine PR #609（`HEAPU8.slice()` 复制到非 resizable buffer 再 decode），已合并 `484209f`。
- **#2（editor 构建路径）**: `cli.mjs` 指向重构前的 `packages/fbx-wasm/`，wasm 建到没人读的地方。→ editor PR #48。
- **#3（editor importer 注册）**: dev-server pluginPack 没注册 `fbxImporter`，`/__import` 对 `meta.importer=fbx` 报 422。→ editor PR #48。
- 两者验证通过：Fox.glb 折叠成 26 成员 SceneInstance mount，humanoid.fbx 85 成员，都 round-trip。

---

## 关键背景（FBX 浏览器 cook 的数据流）

editor 的 FBX 导入**全程在浏览器**完成，无 Node、无 Autodesk FBX SDK：

```
FBX bytes → ufbx WASM (@forgeax/engine-fbx) → JSON POD → parse-*.ts → external-asset-package meta.json
```

- 内容浏览器导入：`content-browser/src/import-pipeline.ts` → `importSingleFile` → `processFbx` → `cookFbxMeta`(`editor-core/src/assets/fbx-cook.ts`) → `@forgeax/engine-fbx` 的 `initFbxWasm()` + `parseFbx()`。
- wasm glue 由 emcc 从 ufbx.c + bridge.c 编译，产物 `packages/engine/packages/fbx/pkg/fbx-wasm.{mjs,wasm}`（gitignored，zero-binary 不变量）。
- 加入场景后，`loadByGuid<SceneAsset>` 需要 DDC 已 cook 的 pack；dev-server 走 pluginPack 的 `POST /__import/<guid>` 惰性 cook，按 `meta.importer` 分派到注册的 importer。

engine 的 `collapse-fbx-to-ufbx` 重构（#603）把旧的 `@forgeax/engine-fbx-wasm` 包**并入** `@forgeax/engine-fbx`（`packages/fbx-wasm/` → `packages/fbx/`）。本次三个 bug 有两个是这次重命名的遗留未跟进。

---

## #1 resizable ArrayBuffer 让 TextDecoder 崩（engine wasm 根因）

**症状**（headless Chromium 实测）:
```
pipeline.processFbx.fail: Failed to execute 'decode' on 'TextDecoder':
The provided ArrayBuffer value must not be resizable
```
cook 在写 `.meta.json` 前就抛错，磁盘上只有原始 `.fbx`、无 meta。

**根因**（`packages/engine/packages/fbx/src/index.ts:147`，修复前）:
```ts
const json = mod.UTF8ToString(resultPtr, resultLen);
```
emcc 编译参数带 `-s ALLOW_MEMORY_GROWTH=1`（FBX 文件可能很大，需堆增长）。在**较新的 emcc**（本地是 `6.0.2-git`）下，生成的 glue 用 `wasmMemory.toResizableBuffer()` 让 `HEAPU8.buffer` 成为 **resizable ArrayBuffer**。glue 的 `UTF8ArrayToString` 走快路径时：
```js
if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
  return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));  // ← subarray 是 resizable buffer 的视图
}
```
现代 Chromium 的 `TextDecoder.decode()` **拒绝** resizable ArrayBuffer 上的视图。结果 JSON 只要超过 16 字节快路径阈值（真实资产必然超）就抛错——所以**每次**浏览器 FBX cook 都失败。

**反证**（确认根因）: 在页面注入 monkeypatch，`TextDecoder.prototype.decode` 检测到 resizable buffer 视图就先复制到普通 buffer 再解码——FBX 立即 cook 成功（`processFbx.done, subAssets:8`）。证明问题**只在这一处解码**。

**修复**（forgeax-engine PR #609，`484209f`）:
```ts
// HEAPU8.slice() 返回一份用普通（非 resizable）ArrayBuffer 后备的拷贝
const bytes = mod.HEAPU8.slice(resultPtr, resultPtr + resultLen);
mod._freeResult();
const json = new TextDecoder().decode(bytes);
```
`.slice()`（区别于 `.subarray()`）**复制**数据到全新的普通 ArrayBuffer，浏览器/Vite、Node、vitest 三个环境都接受；且行为保持不变（parity-snapshot 结构 digest 不变）。engine-fbx 全部 18 个测试文件 / 97 个测试通过，含 node-e2e（Node 解码路径）+ parity-snapshot。

**为什么之前没暴露**: engine 正常走 `pnpm -F @forgeax/engine-fbx fetch-wasm` 拉 **pinned release artifact**（用固定版本 emcc 构建的、不带 resizable buffer 的 glue）。私有 repo 无 `GITHUB_TOKEN` 时 `fetch-wasm` 报 403，回落本地 `build:wasm`（本地 emcc 版本更新）——这才引出 resizable buffer。**根因是解码写法脆弱，不是 emcc 版本**：`.slice()` 修复后无论哪种 glue 都对。

---

## #2 cli.mjs fbx-wasm 构建路径指向重构前的旧目录（editor）

**症状**: 浏览器请求 `.../packages/engine/packages/fbx/pkg/fbx-wasm.mjs` → 404；FBX 导入不可用。

**根因**（`scripts/cli.mjs`，修复前）:
```js
const FBX_WASM_DIR = join(ENGINE_DIR, 'packages', 'fbx-wasm');  // ← 重构前的旧包目录
...
sh('pnpm', ['-F', '@forgeax/engine-fbx-wasm', 'build:wasm'], { cwd: ENGINE_DIR });  // ← 旧包名
```
engine `collapse-fbx-to-ufbx`（#603）已把 `packages/fbx-wasm/` 并入 `packages/fbx/`（包名 `@forgeax/engine-fbx`），wasm 产物落 `packages/fbx/pkg/`。cli 检查/构建的是**死目录**，wasm 建到没人读的地方（或旧包里），runtime 从 `packages/fbx/pkg/` 读不到 → 404。

**修复**（editor PR #48）: `cli.mjs` 的 `FBX_WASM_DIR`/构建命令改到 `packages/fbx` / `@forgeax/engine-fbx`；`AGENTS.md` 里的 `bun -F @forgeax/engine-fbx-wasm build:wasm` 一并改为 `@forgeax/engine-fbx`。

---

## #3 dev-server pluginPack 未注册 fbxImporter（editor）

**症状**: 加入场景时 `loadByGuid` 报 `asset-not-imported`；直接 `POST /__import/<guid>` 返回：
```
HTTP 422 { code: "importer-not-registered",
  reason: "no importer registered for meta.importer \"fbx\"" }
```
scene GUID 在 catalog 里，但 DDC artefact 缺失且没有能 cook fbx 的 importer。

**根因**（`packages/edit-runtime/src/engine/engine-vite-preset.ts`，修复前）:
```ts
pluginPack({ roots, base, importers: [imageImporter, gltfImporter] })  // ← 没有 fbxImporter
```
glTF 能加入场景是因为 `gltfImporter` 已注册；FBX 没有对应 importer，`/__import` 分派失败。

**修复**（editor PR #48）:
- `importers: [imageImporter, gltfImporter, fbxImporter]`。
- 给 `edit-runtime` 加 `@forgeax/engine-fbx` workspace 依赖——否则 `vite.config`（Node 侧）解析不到这个 import，dev server 启动即崩（`ERR_MODULE_NOT_FOUND`）。
- `types/forgeax-engine-shims.d.ts` 的 `declare module '@forgeax/engine-fbx'` 补上 `fbxImporter` export——该 shim 存在是因为 **studio 消费方**用 tsup-only 构建 engine（无 .d.ts），editor 的 import 要靠它解析；缺 `fbxImporter` 会 TS2305。

---

## wasm 构建/分发速查（给后来者）

| 场景 | 命令 / 路径 |
|:--|:--|
| fbx wasm 产物位置 | `packages/engine/packages/fbx/pkg/fbx-wasm.{mjs,wasm}`（gitignored） |
| 本地从源码构建 | `pnpm -F @forgeax/engine-fbx build:wasm`（= `fetch-ufbx` 拉 ufbx.c + `build-wasm` 跑 emcc；需 `brew install emscripten`） |
| 拉 pinned release 产物 | `pnpm -F @forgeax/engine-fbx fetch-wasm`（按 bridge.c 内容 hash 找 release asset；私有 repo 需 `GITHUB_TOKEN`，否则 403 回落本地构建） |
| editor 一键 | `bun run setup`（cli.mjs 内部 `ensureFbxWasm`） |
| wgpu wasm 产物 | `packages/engine/packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm`（Rust + wasm-pack，同样 gitignored） |
| 新 worktree 缺 wasm | 从主 checkout `cp`（engine AGENTS.md「worktree discipline」），或重新 build |

**排错要点**:
- 浏览器 `TextDecoder ... must not be resizable` → emcc glue 的 resizable-buffer 问题，确认 engine pin ≥ `484209f`（#609）。
- `.../fbx/pkg/fbx-wasm.mjs` 404 → cli/构建路径没跟上 collapse 重构，确认指向 `packages/fbx/`。
- `/__import` 422 `importer-not-registered` → pluginPack 的 `importers[]` 没注册对应 importer。
- `fetch-wasm` 403 → 私有 repo 无 token，用 `build:wasm` 本地编（需 emcc）。

---

## 验证方式（附）

headless Chromium 里**没有独特的 "scene loaded" 日志**，用 `[editor] physics gate:` 当就绪标记。全程用**条件等待**（轮询 `pack-index.json` 含目标 GUID / 轮询 `scene.pack.json` 字节变化 / 等日志正则），**不要用固定 `sleep`**：导入写 `.meta.json` 会让 pluginPack 的 `fs.watch` 触发 vite `full-reload`，冲掉页面上下文，固定 sleep 会 race。probe: `e2e/scripts/probe-skinned-import.mjs`。

round-trip 落盘结构（Fox/humanoid 都验证）: `scene.pack.json` = `assets[<scene>]{ refs:[guid...], payload:{entities, mounts} }`；GLB/FBX 折叠成一条 `mounts[]`：`{localId, memberFirst, memberCount, source, parent}`，`source` 是 `refs[]` 索引（Fox=26 成员，humanoid=85 成员）。
