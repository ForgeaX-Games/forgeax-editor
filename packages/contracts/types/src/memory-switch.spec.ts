import { test, expect, describe } from 'bun:test';
import {
  defaultMemorySwitchConfig,
  perKernelDefault,
  memoryAutoExtractEnabled,
  memoryRecallEnabled,
  memoryCacheTip,
  type MemorySwitchConfig,
} from './memory-switch';

describe('memory-switch SSOT resolver', () => {
  test('master off → everything off, ignores per-kernel', () => {
    const cfg: MemorySwitchConfig = { master: false, perKernel: { 'forgeax-core': true } };
    expect(memoryAutoExtractEnabled(cfg, 'forgeax-core', true)).toBe(false);
    expect(memoryAutoExtractEnabled(cfg, 'codex', false)).toBe(false);
    expect(memoryRecallEnabled(cfg)).toBe(false);
  });

  test('master on → per-kernel default by cacheWarmCapable', () => {
    const cfg = defaultMemorySwitchConfig(); // master:true, no overrides
    expect(memoryAutoExtractEnabled(cfg, 'forgeax-core', true)).toBe(true); // cache-warm → default ON
    expect(memoryAutoExtractEnabled(cfg, 'codex', false)).toBe(false); // cache-cold → default OFF
    expect(memoryRecallEnabled(cfg)).toBe(true);
  });

  test('per-kernel override beats the capability default', () => {
    const cfg: MemorySwitchConfig = { master: true, perKernel: { codex: true, 'forgeax-core': false } };
    expect(memoryAutoExtractEnabled(cfg, 'codex', false)).toBe(true); // user opted in despite no cache
    expect(memoryAutoExtractEnabled(cfg, 'forgeax-core', true)).toBe(false); // user opted out
  });

  test('perKernelDefault: warm ON, cold OFF', () => {
    expect(perKernelDefault(true)).toBe(true);
    expect(perKernelDefault(false)).toBe(false);
  });

  test('cache tip: warm → no tip; cold → tip with enabled flag', () => {
    const cfg = defaultMemorySwitchConfig();
    expect(memoryCacheTip(cfg, 'forgeax-core', true)).toEqual({ show: false });
    // cold + default OFF → tip says not-enabled (can opt in)
    expect(memoryCacheTip(cfg, 'codex', false)).toEqual({ show: true, enabled: false });
    // cold + user opted ON → tip warns it burns tokens
    const on: MemorySwitchConfig = { master: true, perKernel: { codex: true } };
    expect(memoryCacheTip(on, 'codex', false)).toEqual({ show: true, enabled: true });
    // master off → cold tip shows but enabled=false
    const off: MemorySwitchConfig = { master: false, perKernel: { codex: true } };
    expect(memoryCacheTip(off, 'codex', false)).toEqual({ show: true, enabled: false });
  });
});
