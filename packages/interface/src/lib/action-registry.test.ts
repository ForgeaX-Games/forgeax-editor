/** action-registry 单测:派发单入口(fail-closed)、参数校验、available、
 *  分层 snapshot、manifest 可序列化(函数永不出墙)。 */
import { describe, expect, test, beforeEach } from 'bun:test';
import {
  registerAction,
  registerStateSlice,
  dispatchAction,
  snapshotActions,
  snapshotState,
  buildManifest,
  __resetRegistryForTest,
} from './action-registry';

beforeEach(() => {
  __resetRegistryForTest();
});

describe('dispatchAction — 单入口 + fail-closed', () => {
  test('未注册 id → rejected 带原因', async () => {
    const r = await dispatchAction('nope.zzz');
    expect(r.status).toBe('rejected');
    expect(r.reason).toContain('nope.zzz');
  });

  test('happy path:void 视为 completed;显式结果透传 stateDigest', async () => {
    registerAction({ id: 'a.void', title: 'v', capability: 'write', run: () => {} });
    registerAction({
      id: 'a.digest',
      title: 'd',
      capability: 'write',
      run: () => ({ status: 'completed', stateDigest: { n: 1 } }),
    });
    expect((await dispatchAction('a.void')).status).toBe('completed');
    const r = await dispatchAction('a.digest');
    expect(r.stateDigest).toEqual({ n: 1 });
  });

  test('available 返回 string → rejected 带人话原因,run 不执行', async () => {
    let ran = false;
    registerAction({
      id: 'a.gated',
      title: 'g',
      capability: 'write',
      available: () => 'panel is closed',
      run: () => {
        ran = true;
      },
    });
    const r = await dispatchAction('a.gated');
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe('panel is closed');
    expect(ran).toBe(false);
  });

  test('schema 校验:required / type / enum', async () => {
    registerAction({
      id: 'a.schema',
      title: 's',
      capability: 'write',
      schema: {
        type: 'object',
        properties: { mode: { type: 'string', enum: ['edit', 'bus'] }, n: { type: 'number' } },
        required: ['mode'],
      },
      run: () => {},
    });
    expect((await dispatchAction('a.schema', {})).reason).toContain('missing required');
    expect((await dispatchAction('a.schema', { mode: 42 })).reason).toContain('should be string');
    expect((await dispatchAction('a.schema', { mode: 'zzz' })).reason).toContain('must be one of');
    expect((await dispatchAction('a.schema', { mode: 'edit', n: 1 })).status).toBe('completed');
  });

  test('run 抛错 → rejected(fail-soft,不炸往返)', async () => {
    registerAction({
      id: 'a.throws',
      title: 't',
      capability: 'write',
      run: () => {
        throw new Error('boom');
      },
    });
    const r = await dispatchAction('a.throws');
    expect(r.status).toBe('rejected');
    expect(r.reason).toContain('boom');
  });
});

describe('snapshot — 分层视图与状态摘要', () => {
  test('默认轻量清单;detail schema 只展开点名的 ids', () => {
    registerAction({
      id: 'a.one',
      title: 'One',
      description: 'desc-one',
      schema: { type: 'object', properties: { x: { type: 'string' } } },
      capability: 'read',
      run: () => {},
    });
    registerAction({ id: 'a.two', title: 'Two', description: 'desc-two', capability: 'read', run: () => {} });
    const light = snapshotActions();
    expect(light.every((r) => !('inputSchema' in r) && !('description' in r))).toBe(true);
    const deep = snapshotActions('schema', ['a.one']);
    const one = deep.find((r) => r.id === 'a.one')!;
    const two = deep.find((r) => r.id === 'a.two')!;
    expect(one.description).toBe('desc-one');
    expect(one.inputSchema).toBeTruthy();
    expect(two.description).toBeUndefined();
  });

  test('状态摘要注册式 derive;单片抛错不传染(fail-soft)', () => {
    registerStateSlice('good', () => ({ v: 1 }));
    registerStateSlice('bad', () => {
      throw new Error('slice-broke');
    });
    const s = snapshotState();
    expect(s.good).toEqual({ v: 1 });
    expect(String((s.bad as { error: string }).error)).toContain('slice-broke');
  });
});

describe('buildManifest — 可序列化(函数永不出墙)', () => {
  test('JSON roundtrip 无损且不含函数;capability/surface/timeoutMs/firstClass 如实出墙', () => {
    registerAction({
      id: 'session.close',
      title: '关闭会话',
      description: 'Destructive close.',
      schema: { type: 'object', properties: { sid: { type: 'string' } }, required: ['sid'] },
      capability: 'delete',
      surface: 'both',
      timeoutMs: 15_000,
      firstClass: true,
      available: () => true,
      run: () => {},
    });
    const manifest = buildManifest();
    const roundtrip = JSON.parse(JSON.stringify(manifest));
    expect(roundtrip).toEqual(manifest);
    const row = roundtrip[0];
    expect(row.capability).toBe('delete');
    expect(row.surface).toBe('both');
    expect(row.timeoutMs).toBe(15_000);
    expect(row.firstClass).toBe(true);
    expect('run' in row).toBe(false);
    expect('available' in row).toBe(false);
  });
});

describe('ai-intents — 意图 pill(P1-10)', () => {
  test('kind 专属在前、通用兜底在后;intentPill 的 detail 带指令与原 detail', async () => {
    const { aiIntentsFor, intentPill } = await import('./ai-intents');
    const consoleIntents = aiIntentsFor('console-row');
    expect(consoleIntents.length).toBeGreaterThan(1);
    expect(consoleIntents[consoleIntents.length - 1]!.label).toContain('这是什么'); // 通用兜底收尾
    const pill = {
      kind: 'log' as const,
      display: 'TypeError: x is null',
      detail: '[console] TypeError: x is null at main.ts:3',
      tooltip: { title: 't', lines: [] },
    };
    const out = intentPill(pill, consoleIntents[0]!);
    expect(out.detail).toContain('TypeError: x is null at main.ts:3'); // 原引用保留
    expect(out.detail).not.toBe(pill.detail); // 带上了意图指令
    expect(out.display).toContain(consoleIntents[0]!.label);
    // 意图 pill 仍是纯可序列化数据(可走 sentinel 编码)。
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});
