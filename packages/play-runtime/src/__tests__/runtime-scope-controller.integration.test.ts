import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RuntimeAssetBinding } from '@forgeax/engine-types';
import type { ForgeaXPackPlugin } from '@forgeax/engine-vite-plugin-pack';
import {
  createRuntimeScopeController,
  type RuntimeScopeCommand,
  type RuntimeScopeControllerOptions,
} from '../runtime-scope-controller';

type Middleware = (req: FakeRequest, res: FakeResponse, next: () => void) => unknown;

type FakeRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers?: Record<string, string>;
  on(event: 'data' | 'end' | 'error', listener: (...args: unknown[]) => void): void;
};

type FakeResponse = {
  statusCode: number;
  body: string;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

function request(
  url: string,
  method: string,
  body: string,
  headers: Record<string, string>,
): FakeRequest {
  return {
    url,
    method,
    headers,
    on(event, listener) {
      if (event === 'data') listener(body);
      if (event === 'end') listener();
    },
  };
}

function response(): FakeResponse {
  return {
    statusCode: 200,
    body: '',
    setHeader() {},
    end(body = '') {
      this.body = body;
    },
  };
}

function command(gameId: string, gameDir: string, generation: number): RuntimeScopeCommand {
  return {
    gameId,
    scopeId: `${gameId}-scope`,
    generation,
    gameDir,
  };
}

function installController(
  options: RuntimeScopeControllerOptions,
): { middleware: Middleware; close(): void } {
  let middleware: Middleware | undefined;
  createRuntimeScopeController(options).configureServer({
    middlewares: {
      use(handler) {
        middleware = handler as Middleware;
      },
    },
  });
  if (middleware === undefined) throw new Error('runtime scope middleware was not installed');
  return { middleware, close() {} };
}

async function bind(
  middleware: Middleware,
  value: RuntimeScopeCommand,
): Promise<FakeResponse> {
  const result = response();
  await middleware(
    request(
      '/__pack/control/bind',
      'POST',
      JSON.stringify(value),
      { 'x-forgeax-runtime-secret': 'integration-secret' },
    ),
    result,
    () => {},
  );
  return result;
}

describe('runtime scope controller integration', () => {
  test('passes canonical project roots atomically for same-basename games', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-runtime-scope-roots-'));
    const gameA = join(root, 'first', 'game');
    const gameB = join(root, 'second', 'game');
    const projectRoots: string[] = [];
    let current: RuntimeAssetBinding | undefined;
    try {
      mkdirSync(gameA, { recursive: true });
      mkdirSync(gameB, { recursive: true });
      const pack = {
        name: 'integration-pack',
        runtimeBinding: () => current,
        rebind: async (
          binding: RuntimeAssetBinding,
          _roots: readonly string[],
          projectDdcRoot?: string,
        ) => {
          projectRoots.push(projectDdcRoot ?? '');
          current = { ...binding, status: 'ready', authority: 'authoritative' };
          return current;
        },
      } as unknown as ForgeaXPackPlugin;
      const { middleware } = installController({
        pack,
        base: '/preview',
        secret: 'integration-secret',
        resolveRoots: (gameDir) => [join(gameDir, 'assets')],
        resolveCatalogRoots: () => [],
        resolveProjectDdcRoot: (gameDir) => join(gameDir, '.forgeax', 'ddc', 'v2'),
      });

      const first = await bind(middleware, command('game', gameA, 41));
      const second = await bind(middleware, command('game', gameB, 42));

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(projectRoots).toEqual([
        join(realpathSync.native(gameA), '.forgeax', 'ddc', 'v2'),
        join(realpathSync.native(gameB), '.forgeax', 'ddc', 'v2'),
      ]);
      expect(projectRoots[0]).not.toBe(projectRoots[1]);
      expect(first.body).not.toContain('projectDdcRoot');
      expect(second.body).not.toContain(gameB);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps the previous binding and redacts failed rebind diagnostics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-runtime-scope-failure-'));
    let current: RuntimeAssetBinding | undefined;
    try {
      mkdirSync(join(root, 'assets'), { recursive: true });
      const pack = {
        name: 'integration-pack',
        runtimeBinding: () => current,
        rebind: async (binding: RuntimeAssetBinding) => {
          if (binding.generation === 42) {
            throw Object.assign(
              new Error(`ddc-lease-expired projectDdcRoot=${join(root, '.forgeax', 'ddc', 'v2')}`),
              { code: 'ddc-lease-expired' },
            );
          }
          current = { ...binding, status: 'ready', authority: 'authoritative' };
          return current;
        },
      } as unknown as ForgeaXPackPlugin;
      const { middleware } = installController({
        pack,
        base: '/preview',
        secret: 'integration-secret',
        resolveRoots: (gameDir) => [join(gameDir, 'assets')],
        resolveCatalogRoots: () => [],
        resolveProjectDdcRoot: (gameDir) => join(gameDir, '.forgeax', 'ddc', 'v2'),
      });

      const first = await bind(middleware, command('game', root, 41));
      const failed = await bind(middleware, command('game', root, 42));
      const snapshot = response();
      await middleware(
        request('/__pack/runtime-binding.json', 'GET', '', {}),
        snapshot,
        () => {},
      );

      expect(first.statusCode).toBe(200);
      expect(failed.statusCode).toBe(409);
      expect(failed.body).not.toContain('projectDdcRoot');
      expect(failed.body).not.toContain(root);
      expect(JSON.parse(snapshot.body)).toMatchObject({ generation: 41, status: 'ready' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
