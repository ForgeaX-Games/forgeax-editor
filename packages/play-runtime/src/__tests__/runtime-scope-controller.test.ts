import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeAssetBinding } from '@forgeax/engine-types';
import type { ForgeaXPackPlugin } from '@forgeax/engine-vite-plugin-pack';
import { createRuntimeScopeController, type RuntimeScopeCommand } from '../runtime-scope-controller';

type Middleware = (req: FakeRequest, res: FakeResponse, next: () => void) => unknown;

type FakeRequest = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  on(event: 'data' | 'end' | 'error', listener: (...args: unknown[]) => void): void;
};

type FakeResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

function response(): FakeResponse {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body = '') {
      this.body = body;
    },
  };
}

function request(
  url: string,
  method: string,
  body = '',
  headers: Record<string, string> = {},
): FakeRequest {
  return {
    url,
    method,
    headers,
    on(event, listener) {
      if (event === 'data' && body.length > 0) listener(body);
      if (event === 'end') listener();
    },
  };
}

function command(gameDir: string, generation: number): RuntimeScopeCommand {
  return {
    gameId: 'fps',
    scopeId: 'fps-scope',
    generation,
    gameDir,
  };
}

describe('runtime scope controller', () => {
  test('requires the server credential and serializes one exact game binding', async () => {
    const gameDir = mkdtempSync(join(tmpdir(), 'forgeax-runtime-scope-'));
    try {
      let current: RuntimeAssetBinding | undefined;
      const calls: Array<{ binding: RuntimeAssetBinding; roots: readonly string[] }> = [];
      const pack = {
        name: 'test-pack',
        runtimeBinding: () => current,
        rebind: async (binding: RuntimeAssetBinding, roots: readonly string[]) => {
          calls.push({ binding, roots });
          current = { ...binding, status: 'ready', authority: 'authoritative' };
          return current;
        },
      } as unknown as ForgeaXPackPlugin;
      let middleware: Middleware | undefined;
      createRuntimeScopeController({
        pack,
        base: '/preview/',
        secret: 'test-secret',
        resolveRoots: (dir) => [join(dir, 'assets')],
      }).configureServer({
        middlewares: {
          use(handler) {
            middleware = handler as Middleware;
          },
        },
      });
      expect(middleware).toBeDefined();

      const forbidden = response();
      await middleware?.(
        request(
          '/__pack/control/bind',
          'POST',
          JSON.stringify(command(gameDir, 1)),
          { 'x-forgeax-runtime-secret': 'wrong-secret' },
        ),
        forbidden,
        () => {},
      );
      expect(forbidden.statusCode).toBe(403);
      expect(calls).toHaveLength(0);

      const accepted = response();
      await middleware?.(
        request(
          '/__pack/control/bind',
          'POST',
          JSON.stringify(command(gameDir, 2)),
          { 'x-forgeax-runtime-secret': 'test-secret' },
        ),
        accepted,
        () => {},
      );
      expect(accepted.statusCode).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.roots).toEqual([join(realpathSync(gameDir), 'assets')]);
      expect(JSON.parse(accepted.body)).toMatchObject({
        gameId: 'fps',
        scopeId: 'fps-scope',
        generation: 2,
        status: 'ready',
        catalogUrl: '/preview/__pack/scopes/fps-scope/2/catalog.json',
      });

      const stale = response();
      await middleware?.(
        request(
          '/__pack/control/bind',
          'POST',
          JSON.stringify(command(gameDir, 1)),
          { 'x-forgeax-runtime-secret': 'test-secret' },
        ),
        stale,
        () => {},
      );
      expect(stale.statusCode).toBe(409);
      expect(calls).toHaveLength(1);
    } finally {
      rmSync(gameDir, { recursive: true, force: true });
    }
  });

  test('reports an unbound runtime instead of exposing a global catalog', async () => {
    const pack = {
      name: 'test-pack',
      runtimeBinding: () => undefined,
    } as unknown as ForgeaXPackPlugin;
    let middleware: Middleware | undefined;
    createRuntimeScopeController({
      pack,
      base: '/preview',
      resolveRoots: () => [],
    }).configureServer({
      middlewares: {
        use(handler) {
          middleware = handler as Middleware;
        },
      },
    });
    const result = response();
    await middleware?.(request('/__pack/runtime-binding.json', 'GET'), result, () => {});
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body)).toEqual({ error: 'runtime-scope-unbound', status: 'unbound' });
  });
});
