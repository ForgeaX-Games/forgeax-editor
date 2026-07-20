/** builtin-actions × manifest 契约一致性(B5,跨包 schema 测试的 interface 半边)。
 *
 *  编排层 `ui-manifest-registry.sanitizeDecl` 的接收规则(cli 侧)在此**镜像成断言**:
 *  id/title 非空、capability ∈ 8 类、inputSchema 可序列化、timeoutMs 正数——任何
 *  builtin action 违反这些规则会在 push 时被 server 整条丢弃(fail-closed → 权限查表
 *  miss → 恒弹卡),这里在测试期就拦下。改任一侧规则时两处同步(cli 侧对应测试:
 *  packages/cli test/ui-bridge.test.ts「manifest 消毒」组)。
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import { buildManifest, __resetRegistryForTest } from './action-registry';
import { registerBuiltinActions } from './builtin-actions';

const VALID_CAPS = new Set(['read', 'write', 'delete', 'exec', 'network', 'credential', 'delegate', 'other']);
const VALID_SURFACES = new Set(['ui', 'server', 'both']);

beforeAll(() => {
  __resetRegistryForTest();
  registerBuiltinActions();
});

describe('builtin actions — 全量过 server 侧接收规则', () => {
  test('每条声明:id/title 非空、capability 合法、surface 合法、timeoutMs 正数', () => {
    const manifest = buildManifest();
    expect(manifest.length).toBeGreaterThanOrEqual(10);
    for (const row of manifest) {
      expect(typeof row.id === 'string' && (row.id as string).length > 0).toBe(true);
      expect(typeof row.title === 'string' && (row.title as string).length > 0).toBe(true);
      expect(VALID_CAPS.has(row.capability as string)).toBe(true);
      if ('surface' in row) expect(VALID_SURFACES.has(row.surface as string)).toBe(true);
      if ('timeoutMs' in row) {
        expect(typeof row.timeoutMs === 'number' && (row.timeoutMs as number) > 0).toBe(true);
      }
    }
  });

  test('整表 JSON roundtrip 无损(结构化克隆/HTTP 都能过)', () => {
    const manifest = buildManifest();
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
  });

  test('破坏性 action 如实声明 delete(session.close 会弹确认卡,这是有意的)', () => {
    const manifest = buildManifest();
    const close = manifest.find((r) => r.id === 'session.close');
    expect(close?.capability).toBe('delete');
  });

  test('firstClass 只标在高频集上且数量 ≤ 编排层上限 24', () => {
    const fc = buildManifest().filter((r) => r.firstClass === true);
    expect(fc.length).toBeGreaterThanOrEqual(4);
    expect(fc.length).toBeLessThanOrEqual(24);
  });
});
