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
import { extensionIdSlug, extensionManifestPathHint, listExtensions } from './extension-api';

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

  it('200 + incomplete json → empty list, no throw', async () => {
    mockFetch(200, 'application/json', JSON.stringify({}));
    const res = await listExtensions('workbench');
    expect(res).toEqual({ kind: 'workbench', count: 0, items: [] });
  });
});

describe('extensionIdSlug — strip known package scopes', () => {
  it('strips @forgeax-extension/, @forgeax-plugin/, and @forgeax/', () => {
    expect(extensionIdSlug('@forgeax-extension/wb-reel')).toBe('wb-reel');
    expect(extensionIdSlug('@forgeax-plugin/wb-observatory')).toBe('wb-observatory');
    expect(extensionIdSlug('@forgeax/wb-game-video')).toBe('wb-game-video');
  });

  it('leaves bare slugs unchanged and does not mangle @forgeax-extension as @forgeax', () => {
    expect(extensionIdSlug('wb-game-video')).toBe('wb-game-video');
    expect(extensionIdSlug('@forgeax-extension/wb-reel')).not.toBe('extension/wb-reel');
  });
});

describe('extensionManifestPathHint — flat Marketplace path', () => {
  it('maps @forgeax-extension/<slug> to packages/marketplace/extensions/<slug>/forgeax-extension.json', () => {
    expect(extensionManifestPathHint('@forgeax-extension/wb-character')).toBe(
      'packages/marketplace/extensions/wb-character/forgeax-extension.json',
    );
  });

  it('maps legacy @forgeax-plugin/<slug> the same way (persisted / pre-rename ids)', () => {
    expect(extensionManifestPathHint('@forgeax-plugin/wb-observatory')).toBe(
      'packages/marketplace/extensions/wb-observatory/forgeax-extension.json',
    );
  });

  it('maps @forgeax/<slug> (arrival-style package scope) the same way', () => {
    expect(extensionManifestPathHint('@forgeax/wb-game-video')).toBe(
      'packages/marketplace/extensions/wb-game-video/forgeax-extension.json',
    );
  });

  it('accepts a bare slug and stays flat (no kind bucket)', () => {
    expect(extensionManifestPathHint('agent-iori')).toBe(
      'packages/marketplace/extensions/agent-iori/forgeax-extension.json',
    );
    expect(extensionManifestPathHint('@forgeax-extension/wb-character')).not.toContain('/workbench/');
    expect(extensionManifestPathHint('@forgeax-extension/wb-character')).not.toContain('manifest.json');
  });
});
