/**
 * Memory switch model (SSOT) —— 自动记忆开关的两层模型 + 生效解析。
 *
 * 跨包共享(core 扁平 auto-memory + cli soul 数字生命都消费),放 `@forgeax/types` 作单一来源,
 * 替代过去 core `memory.enabled` 与 soul `FORGEAX_AUTO_EXTRACT` 各管一半。
 *
 * 两层 + 一个能力位(设计稿 §4):
 *   - **总开关** `master`:关 → 全关(无视分模型);开 → 看分模型。
 *   - **分模型开关** `perKernel[kernelId]`:仅 gate auto-extract(token 成本所在);缺省按能力位默认。
 *   - **缓存能力位** `cacheWarmCapable`(非用户开关,来自 KernelCapabilities.forkExtract):
 *     驱动「默认值」与 UI 提示;cache-warm 默认 ON,cache-cold 默认 OFF(避免悄悄烧 token)。
 *
 * 召回(recall)较廉价(小模型 select)→ 只跟总开关,不分模型 gate。
 */

export interface MemorySwitchConfig {
  /** 总开关。false → 全关(所有模型无视各自开关)。默认 true。 */
  master: boolean;
  /** 分模型 auto-extract 覆盖(kernelId → on/off)。缺键 → 按 perKernelDefault(cacheWarmCapable)。 */
  perKernel: Record<string, boolean>;
}

/** 默认配置:总开关开、无分模型覆盖(各内核按能力位默认)。 */
export function defaultMemorySwitchConfig(): MemorySwitchConfig {
  return { master: true, perKernel: {} };
}

/** 分模型缺省值:cache-warm 内核默认 ON;cache-cold 默认 OFF(不悄悄烧 token)。 */
export function perKernelDefault(cacheWarmCapable: boolean): boolean {
  return cacheWarmCapable;
}

/**
 * SSOT 解析:某内核**是否跑 auto-extract**。
 *   master && (perKernel[kernelId] ?? perKernelDefault(cacheWarmCapable))
 * 总开关关 → 恒 false;总开关开 → 逐内核查覆盖、缺省按能力位默认。
 */
export function memoryAutoExtractEnabled(
  cfg: MemorySwitchConfig,
  kernelId: string,
  cacheWarmCapable: boolean,
): boolean {
  if (!cfg.master) return false;
  const override = cfg.perKernel[kernelId];
  return override ?? perKernelDefault(cacheWarmCapable);
}

/** 召回是否开:只跟总开关(分模型只 gate extract)。 */
export function memoryRecallEnabled(cfg: MemorySwitchConfig): boolean {
  return cfg.master;
}

/** Studio「不省 token」提示判定。`show=false` → 不提示(cache-warm 内核);
 *  `show=true` → 提示,`enabled` 区分文案(false=已默认关·可手动开 / true=已开·每轮额外烧)。 */
export type MemoryCacheTip = { show: false } | { show: true; enabled: boolean };

export function memoryCacheTip(
  cfg: MemorySwitchConfig,
  kernelId: string,
  cacheWarmCapable: boolean,
): MemoryCacheTip {
  if (cacheWarmCapable) return { show: false };
  return { show: true, enabled: memoryAutoExtractEnabled(cfg, kernelId, cacheWarmCapable) };
}
