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

function projectDdcRoot(gameDir: string): string {
  return join(gameDir, '.forgeax', 'ddc', 'v2');
}

describe('runtime scope controller', () => {
  test('keeps the binding payload path-free while passing roots through the host seam', () => {
    const gameDir = mkdtempSync(join(tmpdir(), 'forgeax-runtime-scope-census-'));
    try {
      let current: RuntimeAssetBinding | undefined;
      let receivedRoots: readonly string[] | undefined;
      const pack = {
        name: 'test-pack',
        runtimeBinding: () => current,
        rebind: async (binding: RuntimeAssetBinding, roots: readonly string[]) => {
          receivedRoots = roots;
          current = { ...binding, status: 'ready', authority: 'authoritative' };
          return current;
        },
      } as unknown as ForgeaXPackPlugin;

      const controller = createRuntimeScopeController({
        pack,
        base: '/preview',
        resolveRoots: (dir) => [join(dir, 'assets')],
        resolveCatalogRoots: () => [],
        resolveProjectDdcRoot: projectDdcRoot,
      });
      let middleware: Middleware | undefined;
      controller.configureServer({
        middlewares: { use(handler) { middleware = handler as Middleware; } },
      });

      const result = response();
      void middleware?.(request('/__pack/control/bind', 'POST', JSON.stringify(command(gameDir, 1))), result, () => {});
      expect(receivedRoots).toBeUndefined();
      expect(result.body).not.toContain('gameDir');
      expect(result.body).not.toContain('projectDdcRoot');
    } finally {
      rmSync(gameDir, { recursive: true, force: true });
    }
  });

  test('requires the server credential and serializes one exact game binding', async () => {
    const gameDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'forgeax-runtime-scope-')));
    try {
      let current: RuntimeAssetBinding | undefined;
      const calls: Array<{
        binding: RuntimeAssetBinding;
        roots: readonly string[];
        projectDdcRoot: string | undefined;
      }> = [];
      const pack = {
        name: 'test-pack',
        runtimeBinding: () => current,
        rebind: async (
          binding: RuntimeAssetBinding,
          roots: readonly string[],
          nextProjectDdcRoot?: string,
        ) => {
          calls.push({ binding, roots, projectDdcRoot: nextProjectDdcRoot });
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
        resolveProjectDdcRoot: projectDdcRoot,
        resolveCatalogRoots: () => [{ root: 'assets', catalogPrefix: 'host-games/fps/assets' }],
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
      expect(calls[0]?.roots).toEqual([join(gameDir, 'assets')]);
      expect(calls[0]?.projectDdcRoot).toBe(projectDdcRoot(gameDir));
      expect(JSON.parse(accepted.body)).toMatchObject({
        gameId: 'fps',
        scopeId: 'fps-scope',
        generation: 2,
        status: 'ready',
        catalogUrl: '/preview/__pack/scopes/fps-scope/2/catalog.json',
        catalogRoots: [{ root: 'assets', catalogPrefix: 'host-games/fps/assets' }],
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
      resolveProjectDdcRoot: projectDdcRoot,
      resolveCatalogRoots: () => [],
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

  test('holds the binding probe until the initial bind publishes a ready snapshot', async () => {
    const gameDir = mkdtempSync(join(tmpdir(), 'forgeax-runtime-scope-initial-'));
    try {
      let current: RuntimeAssetBinding | undefined;
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pack = {
        name: 'test-pack',
        runtimeBinding: () => current,
        rebind: async (binding: RuntimeAssetBinding) => {
          await pending;
          current = { ...binding, status: 'ready', authority: 'authoritative' };
          return current;
        },
      } as unknown as ForgeaXPackPlugin;
      let middleware: Middleware | undefined;
      createRuntimeScopeController({
        pack,
        base: '/preview',
        initial: command(gameDir, 1),
        resolveRoots: () => [],
        resolveProjectDdcRoot: projectDdcRoot,
        resolveCatalogRoots: () => [],
      }).configureServer({
        middlewares: {
          use(handler) {
            middleware = handler as Middleware;
          },
        },
      });
      expect(middleware).toBeDefined();

      const result = response();
      let completed = false;
      const probe = Promise.resolve(
        middleware?.(request('/__pack/runtime-binding.json', 'GET'), result, () => {}),
      )
        .then(() => {
          completed = true;
        });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(completed).toBe(false);
      expect(result.body).toBe('');

      release();
      await probe;
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toMatchObject({
        gameId: 'fps',
        scopeId: 'fps-scope',
        generation: 1,
        status: 'ready',
      });
    } finally {
      rmSync(gameDir, { recursive: true, force: true });
    }
  });

  test('coalesces an in-flight generation and replays its committed binding', async () => {
    const gameDir = mkdtempSync(join(tmpdir(), 'forgeax-runtime-scope-idempotent-'));
    try {
      let current: RuntimeAssetBinding | undefined;
      let calls = 0;
      let releaseBind: (() => void) | undefined;
      const bindBlocked = new Promise<void>((resolve) => {
        releaseBind = resolve;
      });
      let markStarted: (() => void) | undefined;
      const bindStarted = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const pack = {
        name: 'test-pack',
        runtimeBinding: () => current,
        rebind: async (binding: RuntimeAssetBinding) => {
          calls += 1;
          markStarted?.();
          await bindBlocked;
          current = { ...binding, status: 'ready', authority: 'authoritative' };
          return current;
        },
      } as unknown as ForgeaXPackPlugin;
      let middleware: Middleware | undefined;
      createRuntimeScopeController({
        pack,
        base: '/preview',
        secret: 'test-secret',
        resolveRoots: () => [],
        resolveProjectDdcRoot: projectDdcRoot,
        resolveCatalogRoots: () => [],
      }).configureServer({ middlewares: { use: (handler) => { middleware = handler as Middleware; } } });

      const invoke = async () => {
        const result = response();
        await middleware?.(
          request('/__pack/control/bind', 'POST', JSON.stringify(command(gameDir, 7)), {
            'x-forgeax-runtime-secret': 'test-secret',
          }),
          result,
          () => {},
        );
        return result;
      };
      const first = invoke();
      await bindStarted;
      const duplicate = invoke();
      await Promise.resolve();
      expect(calls).toBe(1);
      releaseBind?.();
      const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
      expect(firstResult.statusCode).toBe(200);
      expect(duplicateResult.statusCode).toBe(200);

      const replay = await invoke();
      expect(replay.statusCode).toBe(200);
      expect(calls).toBe(1);
    } finally {
      rmSync(gameDir, { recursive: true, force: true });
    }
  });

  test('allows the same generation to retry after a non-ready candidate', async () => {
    const gameDir = mkdtempSync(join(tmpdir(), 'forgeax-runtime-scope-retry-'));
    try {
      let calls = 0;
      const pack = {
        name: 'test-pack',
        runtimeBinding: () => undefined,
        rebind: async (binding: RuntimeAssetBinding) => {
          calls += 1;
          return { ...binding, status: calls === 1 ? 'transitioning' : 'ready' };
        },
      } as unknown as ForgeaXPackPlugin;
      let middleware: Middleware | undefined;
      createRuntimeScopeController({
        pack,
        base: '/preview',
        secret: 'test-secret',
        resolveRoots: () => [],
        resolveProjectDdcRoot: projectDdcRoot,
        resolveCatalogRoots: () => [],
      }).configureServer({ middlewares: { use: (handler) => { middleware = handler as Middleware; } } });

      const invoke = async () => {
        const result = response();
        await middleware?.(
          request('/__pack/control/bind', 'POST', JSON.stringify(command(gameDir, 8)), {
            'x-forgeax-runtime-secret': 'test-secret',
          }),
          result,
          () => {},
        );
        return result;
      };
      expect((await invoke()).statusCode).toBe(409);
      expect((await invoke()).statusCode).toBe(200);
      expect(calls).toBe(2);
    } finally {
      rmSync(gameDir, { recursive: true, force: true });
    }
  });

  test('rejects a restored binding from a different game generation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-runtime-scope-identity-'));
    try {
      const previous: RuntimeAssetBinding = {
        schemaVersion: 'runtime-asset-binding-v1',
        gameId: 'previous',
        scopeId: 'previous-scope',
        generation: 8,
        status: 'degraded',
        catalogUrl: '/preview/__pack/scopes/previous-scope/8/catalog.json',
        importUrlBase: '/preview/__pack/scopes/previous-scope/8/import',
        packageUrlBase: '/preview/__pack/scopes/previous-scope/8/asset',
      };
      const pack = {
        name: 'test-pack',
        runtimeBinding: () => previous,
        rebind: async () => previous,
      } as unknown as ForgeaXPackPlugin;
      let middleware: Middleware | undefined;
      createRuntimeScopeController({
        pack,
        base: '/preview',
        secret: 'test-secret',
        resolveRoots: () => [],
        resolveProjectDdcRoot: projectDdcRoot,
        resolveCatalogRoots: () => [],
      }).configureServer({ middlewares: { use: (handler) => { middleware = handler as Middleware; } } });

      const result = response();
      await middleware?.(
        request('/__pack/control/bind', 'POST', JSON.stringify(command(root, 9)), {
          'x-forgeax-runtime-secret': 'test-secret',
        }),
        result,
        () => {},
      );

      expect(result.statusCode).toBe(409);
      expect(JSON.parse(result.body)).toMatchObject({
        error: 'runtime-scope-bind-failed',
        code: 'runtime-binding-mismatch',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('commits the candidate mount only for an exact binding and rolls it back on mismatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-runtime-scope-mount-'));
    try {
      let current: RuntimeAssetBinding | undefined;
      const mountEvents: string[] = [];
      const pack = {
        name: 'test-pack',
        runtimeBinding: () => current,
        rebind: async (binding: RuntimeAssetBinding) => {
          if (binding.generation === 10) return current;
          current = { ...binding, status: 'ready', authority: 'authoritative' };
          return current;
        },
      } as unknown as ForgeaXPackPlugin;
      let middleware: Middleware | undefined;
      createRuntimeScopeController({
        pack,
        base: '/preview',
        secret: 'test-secret',
        prepareGameMount: (_gameDir, gameId) => {
          mountEvents.push(`stage:${gameId}`);
          return {
            commit: () => { mountEvents.push(`commit:${gameId}`); },
            rollback: () => { mountEvents.push(`rollback:${gameId}`); },
          };
        },
        resolveRoots: () => [],
        resolveCatalogRoots: () => [],
        resolveProjectDdcRoot: projectDdcRoot,
      }).configureServer({ middlewares: { use: (handler) => { middleware = handler as Middleware; } } });

      const invoke = async (generation: number) => {
        const result = response();
        await middleware?.(
          request('/__pack/control/bind', 'POST', JSON.stringify(command(root, generation)), {
            'x-forgeax-runtime-secret': 'test-secret',
          }),
          result,
          () => {},
        );
        return result;
      };

      expect((await invoke(9)).statusCode).toBe(200);
      const failed = await invoke(10);
      expect(failed.statusCode).toBe(409);
      expect(JSON.parse(failed.body)).toMatchObject({ code: 'runtime-binding-mismatch' });
      expect(mountEvents).toEqual([
        'stage:fps',
        'commit:fps',
        'stage:fps',
        'rollback:fps',
      ]);
      expect(current).toMatchObject({ generation: 9, status: 'ready' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps the last ready binding across a failed candidate and rejects stale recovery work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-runtime-scope-recovery-'));
    try {
      let current: RuntimeAssetBinding | undefined;
      const pack = {
        name: 'test-pack',
        runtimeBinding: () => current,
        rebind: async (binding: RuntimeAssetBinding) => {
          if (binding.generation === 10) return { ...binding, status: 'transitioning' };
          current = { ...binding, status: 'ready', authority: 'authoritative' };
          return current;
        },
      } as unknown as ForgeaXPackPlugin;
      let middleware: Middleware | undefined;
      createRuntimeScopeController({
        pack,
        base: '/preview',
        secret: 'test-secret',
        resolveRoots: () => [],
        resolveCatalogRoots: () => [],
        resolveProjectDdcRoot: projectDdcRoot,
      }).configureServer({ middlewares: { use: (handler) => { middleware = handler as Middleware; } } });

      const invoke = async (value: RuntimeScopeCommand) => {
        const result = response();
        await middleware?.(
          request('/__pack/control/bind', 'POST', JSON.stringify(value), {
            'x-forgeax-runtime-secret': 'test-secret',
          }),
          result,
          () => {},
        );
        return result;
      };
      const first = await invoke(command(root, 9));
      const failed = await invoke(command(root, 10));
      const stale = await invoke(command(root, 8));
      const snapshotAfterFailure = response();
      await middleware?.(
        request('/__pack/runtime-binding.json', 'GET'),
        snapshotAfterFailure,
        () => {},
      );
      const recovered = await invoke(command(root, 11));

      expect(first.statusCode).toBe(200);
      expect(failed.statusCode).toBe(409);
      expect(stale.statusCode).toBe(409);
      expect(JSON.parse(failed.body)).toMatchObject({
        error: 'runtime-scope-bind-failed',
        code: 'runtime-scope-bind-failed',
      });
      expect(JSON.parse(stale.body)).toMatchObject({
        error: 'runtime-scope-bind-failed',
        code: 'runtime-generation-stale',
      });
      expect(failed.body).not.toContain(root);
      expect(stale.body).not.toContain(root);
      expect(JSON.parse(snapshotAfterFailure.body)).toMatchObject({ generation: 9, status: 'ready' });
      expect(recovered.statusCode).toBe(200);
      expect(JSON.parse(recovered.body)).toMatchObject({ generation: 11, status: 'ready' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
