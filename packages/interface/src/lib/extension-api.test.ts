/**
 * bus-api degrade contract: the plugin bus is a studio-only surface. The
 * standalone editor has no bus router, so listExtensions() must DEGRADE to an
 * empty list — never throw — whichever way "no backend" presents:
 *   - no `--game`: SPA fallback → 200 + text/html
 *   - with `--game`: game-backend answers non-bus routes → 404 + json
 * Regression guard for the Uncaught(in promise) Error that the 404+json case
 * raised in DockShell's boot effect before the fix.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { listExtensions } from './extension-api';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const mockFetch = (status: number, contentType: string, body: string) => {
  globalThis.fetch = (async () =>
    new Response(body, { status, headers: { 'content-type': contentType } })) as typeof fetch;
};

describe('listExtensions — no-bus degrade', () => {
  it('404 + json (--game game-backend) → empty list, no throw', async () => {
    mockFetch(404, 'application/json', JSON.stringify({ error: 'not found' }));
    const res = await listExtensions('workbench');
    expect(res).toEqual({ kind: 'workbench', count: 0, items: [] });
  });

  it('200 + html (no-game SPA fallback) → empty list, no throw', async () => {
    mockFetch(200, 'text/html', '<!doctype html><html></html>');
    const res = await listExtensions('workbench');
    expect(res).toEqual({ kind: 'workbench', count: 0, items: [] });
  });

  it('200 + json (real bus) → parsed payload', async () => {
    const payload = { kind: 'workbench', count: 1, items: [{ id: 'p1' }] };
    mockFetch(200, 'application/json', JSON.stringify(payload));
    const res = await listExtensions('workbench');
    expect(res).toEqual(payload);
  });
});
