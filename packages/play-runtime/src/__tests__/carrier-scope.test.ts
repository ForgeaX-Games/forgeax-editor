import { expect, test } from 'bun:test';
import { resolveCarrierScope } from '../carrier-scope';

test('an Editor iframe without a challenge uses host scope facts for its requested game', async () => {
  const fetcher = async (url: any) => Response.json(url === '/api/health' ? { instanceRootAbs: '/project' } : { activeSlug: 'kart' });
  expect(await resolveCarrierScope('runtime', 'kart', fetcher as typeof fetch)).toEqual({ projectId: '/project', gameId: 'kart' });
  expect(await resolveCarrierScope('runtime', 'other', fetcher as typeof fetch)).toBeNull();
});
test('standalone previews need no managed identity and unavailable host scope is bounded', async () => {
  let calls = 0;
  const unavailable = (_url: any, options: any) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  };
  expect(await resolveCarrierScope(null, 'kart', unavailable as typeof fetch, 2)).toBeNull();
  expect(calls).toBe(0);
  expect(await resolveCarrierScope('runtime', 'kart', unavailable as typeof fetch, 2)).toBeNull();
  expect(calls).toBe(2);
});
