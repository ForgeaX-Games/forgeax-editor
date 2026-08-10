/** 界面**真的把 started 写进了 /ack 请求体**吗?
 *
 *  2026-08-07 外审实证:两端各有钉子(Error 上带标记 / 服务端会转发手工构造的字段),
 *  唯独中间这段传递无人证明 —— 把 surface.ts 里 body 的 started 展开删掉,本仓 392 条
 *  测试照样全绿。这已经是本轮同一形状("护栏只装一口 / 只测两端不测中间")的第四次。
 *  所以这里钉的是**请求体本身**。 */
import { expect, test } from 'bun:test';
import { renderHook, waitFor } from '@testing-library/react';
import { useSurface } from './surface';

async function ackBodyFor(error: Error, surfaceId: string): Promise<Record<string, unknown>> {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  let pendingConsumed = false;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push({ url, method, body });
    if (method === 'GET' && url.includes(`/${surfaceId}/pending?`)) {
      // pending 只在首次给 item,避免同一个动作被轮询重复消费。
      const items = pendingConsumed ? [] : [{ token: `tok-${surfaceId}`, action: 'invoke', args: {}, source: 'ai' }];
      pendingConsumed = true;
      return Response.json({ items });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;

  const { unmount } = renderHook(() => useSurface({
    id: surfaceId,
    actions: { invoke: { id: 'invoke', run: async () => { throw error; } } },
  }));

  try {
    // 轮询是异步的:等到 ack 出现为止,不写死 sleep(那会绑死轮询间隔的实现细节)。
    await waitFor(
      () => { expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/ack'))).toBe(true); },
      { timeout: 3_000, interval: 10 },
    );
    return requests.find((r) => r.method === 'POST' && r.url.endsWith('/ack'))!.body!;
  } finally {
    unmount();
    globalThis.fetch = originalFetch;
  }
}

test('动作跑起来之后才失败 → /ack 请求体里 started=true', async () => {
  const err = new Error('调用失败') as Error & { started?: boolean };
  err.started = true;
  const body = await ackBodyFor(err, 'surf-started');
  expect(body.ok).toBe(false);
  expect(body.started).toBe(true);
});

test('普通错误 → /ack 请求体里**没有** started 这个键(缺席=未知,不能用 false 冒充"确定没开始")', async () => {
  const body = await ackBodyFor(new Error('普通失败'), 'surf-plain');
  expect(body.ok).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(body, 'started')).toBe(false);
});
