import type { CreatableAssetKind } from '@forgeax/editor-core';

/** editor 内可**直接创建**（Add 按钮，空模板起手）的 asset kind 白名单。
 *  ⚠️ 与引擎 `Asset['kind']` 联合的关系是**受限子集**——大部分 kind 通过 Import
 *  管线从外部文件引入（mesh/texture/audio/font/... 空壳无意义）；这里只列
 *  「能从空初值起手编辑」的 kind。是 editor **产品决定**，不是引擎权威表，
 *  所以 SSOT 住在 editor 侧、editor 侧扩展。
 *
 *  扩展流程：本表加一行 + `applier.defaultPayloadFor` 加对应 case 即可。
 *  编译期 exhaustiveness check（`applier` switch 无 default 分支）保障新加
 *  kind 忘写 payload 时 TS 直接报错。*/
export interface CreatableAssetSpec {
  /** engine Asset discriminant（受限于 CreatableAssetKind 子集）*/
  readonly kind: CreatableAssetKind;
  /** Add 菜单显示名 */
  readonly label: string;
  /** Add 菜单图标：lucide 图标名（经 ContentBrowserIcon 渲染），与
   *  `content-browser-icons` 的 family/kind 图标同一套体系，禁用 emoji。 */
  readonly icon: string;
  /** 用户未输入时的默认名前缀 */
  readonly defaultNamePrefix: string;
}

export const CREATABLE_ASSET_KINDS: readonly CreatableAssetSpec[] = [
  { kind: 'scene', label: 'Scene', icon: 'clapperboard', defaultNamePrefix: 'NewScene' },
] as const;

/** 类型层守卫：`CreatableAssetKind` 字面量通过 core applier 的 exhaustive switch
 *  与 `SceneAsset` type 编译期兜底漂移。此处不需要引擎 `Asset['kind']` 导入。 */
void (CREATABLE_ASSET_KINDS satisfies readonly CreatableAssetSpec[]);
