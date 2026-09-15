import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeAssetBinding } from '@forgeax/engine-types';
import type { PluginPack } from '@forgeax/engine-vite-plugin-pack';
import { createRuntimeScopeController, type RuntimeScopeCommand } from '../runtime-scope-controller';
import { loadRuntimeBinding } from '../runtime-binding-loader';

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
  test('authors only the bound project and rejects stale viewport operations after rebinding', async () => {
    const first = realpathSync.native(mkdtempSync(join(tmpdir(), 'source-first-')));
    const second = realpathSync.native(mkdtempSync(join(tmpdir(), 'source-second-')));
    try {
      let current: RuntimeAssetBinding | undefined;
      const pack = {
        runtimeBinding: () => current,
        rebind: async (binding: RuntimeAssetBinding) => {
          current = { ...binding, status: 'ready', authority: 'authoritative' };
          return current;
        },
      } as unknown as PluginPack;
      let middleware!: Middleware;
      createRuntimeScopeController({
        pack, base: '/preview/', secret: 'secret',
        resolveRoots: (dir) => [join(dir, 'assets')],
        resolveProjectDdcRoot: projectDdcRoot, resolveCatalogRoots: () => [],
      }).configureServer({ middlewares: { use(handler) { middleware = handler as Middleware; } } });
      const call = async (url: string, body: unknown, headers = {}) => {
        const result = response();
        await middleware(request(url, 'POST', typeof body === 'string' ? body : JSON.stringify(body), headers), result, () => {});
        return { status: result.statusCode, body: JSON.parse(result.body) };
      };
      const bind = (dir: string, generation: number) => call('/__pack/control/bind', command(dir, generation), { 'x-forgeax-runtime-secret': 'secret' });
      const endpoint = '/preview/api/assets/source/execute';
      const scope = { 'x-forgeax-game-id': 'fps', 'x-forgeax-scope-id': 'fps-scope', 'x-forgeax-generation': '1' };
      const sourcePath = 'assets/generated.pack.ts';
      const create = { requestId: 'create', kind: 'create-scriptable-pack', sourcePath, name: 'Generated', initialOutput: { sourceKey: 'scene/main', kind: 'scene', name: 'Main' } };
      expect((await call(endpoint, create, scope)).status).toBe(409);
      await bind(first, 1);
      const validationEndpoint = '/preview/api/validation/project';
      expect((await call(validationEndpoint, {})).status).toBe(409);
      expect((await call(validationEndpoint, '{', scope)).status).toBe(400);
      expect((await call(validationEndpoint, [], scope)).status).toBe(400);
      expect((await call(validationEndpoint, { maxBytes: -1 }, scope)).status).toBe(400);
      const validation = await call(validationEndpoint, {}, scope);
      expect(validation.status).toBe(200);
      expect(validation.body.gameDir).toBe(first);
      expect(validation.body.blocking.length).toBeGreaterThan(0);

      expect((await call(endpoint, create)).status).toBe(409);
      expect((await call(endpoint, '{', scope)).status).toBe(400);
      expect((await call(endpoint, create, scope)).body.ok).toBe(true);
      expect(existsSync(join(first, sourcePath))).toBe(true);
      expect(existsSync(join(second, sourcePath))).toBe(false);
      const preflight = await call(endpoint, { requestId: 'inspect', kind: 'preflight', sourcePath }, scope);
      expect(preflight.body.ok).toBe(true);
      expect((await call(endpoint, { requestId: 'rebuild', kind: 'rebuild', sourcePath, expectedRevision: preflight.body.value.revision }, scope)).body.ok).toBe(true);
      expect((await call(endpoint, { requestId: 'escape', kind: 'preflight', sourcePath: '../other.pack.ts' }, scope)).body.ok).toBe(false);
      await bind(second, 2);
      expect((await call(validationEndpoint, {}, scope)).status).toBe(409);
      const secondValidation = await call(validationEndpoint, {}, { ...scope, 'x-forgeax-generation': '2' });
      expect(secondValidation.status).toBe(200);
      expect(secondValidation.body.gameDir).toBe(second);
      expect((await call(endpoint, create, scope)).status).toBe(409);
      expect(existsSync(join(second, sourcePath))).toBe(false);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

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
      } as unknown as PluginPack;

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
      } as unknown as PluginPack;
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
    } as unknown as PluginPack;
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
      } as unknown as PluginPack;
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
      } as unknown as PluginPack;
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
      } as unknown as PluginPack;
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
      } as unknown as PluginPack;
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
      } as unknown as PluginPack;
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
      } as unknown as PluginPack;
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


for (const advanceFailedBinding of [false, true]) test(`source recovery invalidates old readiness after a failed rebind (producer advances: ${advanceFailedBinding})`, async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'recovery-control-')));
  const other = realpathSync.native(mkdtempSync(join(tmpdir(), 'recovery-other-')));
  try {
    mkdirSync(join(root, 'assets'));
    mkdirSync(join(other, 'assets'));
    const farm = join(other, 'farm-alias');
    writeFileSync(join(root, 'assets/a.png'), 'source');
    let current: RuntimeAssetBinding | undefined;
    let rejectBind = false;
    let middleware!: Middleware;
    const pack = {
      runtimeBinding: () => current,
      rebind: async (binding: RuntimeAssetBinding) => {
        if (rejectBind) {
          if (advanceFailedBinding) current = { ...binding, status: 'unavailable', authority: 'authoritative' };
          throw Object.assign(new Error('private error'), {
          code: 'scan-failed', expected: 'valid source catalog', hint: 'repair the named source',
          detail: { cause: { code: 'pack-orphan-meta', detail: { expectedFile: join(farm, 'other.png') } } },
          });
        }
        current = { ...binding, status: 'ready', authority: 'authoritative' };
        return current;
      },
    } as unknown as PluginPack;
    createRuntimeScopeController({ pack, base: '/preview', secret: 'secret', resolveRoots: () => [farm],
      prepareGameMount: () => {
        rmSync(farm, { force: true });
        symlinkSync(join(root, 'assets'), farm);
        return { commit() {}, rollback() {
          rmSync(farm, { force: true });
          symlinkSync(join(other, 'assets'), farm);
        } };
      },
      resolveProjectDdcRoot: projectDdcRoot, resolveCatalogRoots: () => [],
    }).configureServer({ middlewares: { use(handler) { middleware = handler as Middleware; } } });
    const call = async (url: string, body: unknown, authorized = true) => {
      const result = response();
      await middleware(request(url, 'POST', JSON.stringify(body), authorized ? { 'x-forgeax-runtime-secret': 'secret' } : {}), result, () => {});
      return { status: result.statusCode, body: JSON.parse(result.body) };
    };
    await call('/__pack/control/bind', command(root, 1));
    const endpoint = '/__pack/control/recover-asset';
    expect((await call(endpoint, { ...command(root, 2), sourcePath: 'assets/a.png' }, false)).status).toBe(403);
    expect(existsSync(join(root, 'assets/a.png.meta.json'))).toBe(false);
    expect((await call(endpoint, { ...command(other, 2), sourcePath: 'assets/a.png' })).body).toMatchObject({ code: 'asset-recovery-scope-mismatch', metadataRebuilt: false });
    expect((await call(endpoint, { ...command(root, 1), sourcePath: 'assets/a.png' })).body).toMatchObject({ code: 'runtime-generation-stale', metadataRebuilt: false });
    expect(existsSync(join(root, 'assets/a.png.meta.json'))).toBe(false);
    rejectBind = true;
    const partial = await call(endpoint, { ...command(root, 2), sourcePath: 'assets/a.png' });
    expect(partial.body).toMatchObject({ code: 'scan-failed', metadataRebuilt: true, diagnostic: { cause: { detail: { cause: { detail: { expectedFile: './assets/other.png' } } } } } });
    expect(partial.status).toBe(409);
    const failedSnapshot = response();
    await middleware(request('/__pack/runtime-binding.json', 'GET'), failedSnapshot, () => {});
    expect(failedSnapshot.statusCode).toBe(503);
    expect(JSON.parse(failedSnapshot.body)).toMatchObject({ status: 'unavailable', code: 'scan-failed', diagnostic: { detail: { cause: { detail: { expectedFile: './assets/other.png' } } } } });
    expect(JSON.parse(failedSnapshot.body).status).not.toBe('ready');
    const meta = JSON.parse(readFileSync(join(root, 'assets/a.png.meta.json'), 'utf8'));
    rejectBind = false;
    const ready = await call(endpoint, { ...command(root, 3), sourcePath: 'assets/a.png' });
    expect(ready.body).toMatchObject({ ok: true, sourcePath: 'assets/a.png', metaPath: 'assets/a.png.meta.json', metadataRebuilt: true, binding: { generation: 3, status: 'ready' } });
    expect(ready.body.subAssets).toEqual(meta.subAssets);
    const readySnapshot = response();
    await middleware(request('/__pack/runtime-binding.json', 'GET'), readySnapshot, () => {});
    expect(readySnapshot.statusCode).toBe(200);
    expect(JSON.parse(readySnapshot.body)).toMatchObject({ generation: 3, status: 'ready' });
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

for (const degradation of ['status', 'authority', 'blocking'] as const) test(`metadata recovery rejects producer ${degradation} degradation`, async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'recovery-degraded-')));
  try {
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'assets/a.png'), 'source');
    let current: RuntimeAssetBinding | undefined;
    let middleware!: Middleware;
    const blocking = { code: 'scan-failed', severity: 'blocking' as const, expected: 'valid catalog', hint: 'repair the remaining source', actual: join(root, 'assets/other.png') };
    const pack = {
      runtimeBinding: () => current,
      rebind: async (binding: RuntimeAssetBinding) => {
        current = { ...binding, status: binding.generation === 2 && degradation === 'status' ? 'degraded' : 'ready',
          authority: binding.generation === 2 && degradation === 'authority' ? 'degraded' : 'authoritative',
          diagnostics: binding.generation === 2 && degradation === 'blocking' ? [blocking] : [],
        };
        return current;
      },
    } as unknown as PluginPack;
    createRuntimeScopeController({ pack, base: '/preview', secret: 'secret', resolveRoots: (dir) => [dir],
      resolveProjectDdcRoot: projectDdcRoot, resolveCatalogRoots: () => [],
    }).configureServer({ middlewares: { use(handler) { middleware = handler as Middleware; } } });
    const call = async (url: string, body?: unknown) => {
      const result = response();
      await middleware(request(url, body === undefined ? 'GET' : 'POST', JSON.stringify(body), { 'x-forgeax-runtime-secret': 'secret' }), result, () => {});
      return { status: result.statusCode, body: JSON.parse(result.body) };
    };
    await call('/__pack/control/bind', command(root, 1));
    const failed = await call('/__pack/control/recover-asset', { ...command(root, 2), sourcePath: 'assets/a.png' });
    expect(failed.status).toBe(409);
    expect(failed.body.metadataRebuilt).toBe(true);
    expect(failed.body.code).toBe(degradation === 'blocking' ? 'scan-failed' : 'runtime-asset-recovery-not-ready');
    expect(failed.body.diagnostic.cause.detail).toMatchObject({ status: current!.status, authority: current!.authority });
    if (degradation === 'blocking') expect(failed.body.diagnostic.cause.detail.diagnostics).toMatchObject([{ ...blocking, actual: './assets/other.png' }]);
    const snapshot = await call('/__pack/runtime-binding.json');
    expect(snapshot.status).toBe(503);
    expect(snapshot.body.status).toBe('unavailable');
    const ready = await call('/__pack/control/recover-asset', { ...command(root, 3), sourcePath: 'assets/a.png' });
    expect(ready.status).toBe(200);
    expect(ready.body.binding.status).toBe('ready');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('same-scope producer publications replace cached status in GET and idempotent bind', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'controller-diagnostic-')));
  let handler: any, current: any, fail = true;
  const command = { gameId: 'kart', scopeId: 'kart-scope', generation: 1, gameDir: dir };
  const pack = { runtimeBinding: () => current, rebind: async (binding: any) => {
    if (fail) throw { code: 'scan-failed', cause: [{ code: 'pack-source-external-closure-mismatch', detail: { sourcePath: join(dir, 'scene.pack.ts'), undeclaredReadGuids: ['missing'] } }] };
    return current = { ...binding, status: 'ready' };
  } };
  try {
    createRuntimeScopeController({ pack: pack as any, base: '/preview/', secret: 'secret', resolveRoots: () => [dir], resolveProjectDdcRoot: () => join(dir, '.ddc'), resolveCatalogRoots: () => [] }).configureServer({ middlewares: { use: (value: any) => { handler = value; } } });
    const call = async (url: string, body?: unknown) => {
      let text = ''; const res = { statusCode: 200, setHeader: () => {}, end: (value: string) => { text = value; } };
      await handler({ url, method: body ? 'POST' : 'GET', headers: { 'x-forgeax-runtime-secret': 'secret' }, on: (event: string, fn: (value?: string) => void) => { if (event === 'data') fn(JSON.stringify(body)); if (event === 'end') fn(); } }, res, () => { throw new Error('unexpected route'); });
      return new Response(text, { status: res.statusCode });
    };
    expect(await (await call('/__pack/runtime-binding.json')).json()).toMatchObject({ status: 'unbound' });
    expect((await call('/__pack/control/bind', command)).status).toBe(409);
    const failed = await call('/__pack/runtime-binding.json');
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ gameId: 'kart', scopeId: 'kart-scope', generation: 1, status: 'unavailable', diagnostic: { cause: [{ code: 'pack-source-external-closure-mismatch', detail: { sourcePath: './scene.pack.ts', undeclaredReadGuids: ['missing'] } }] } });
    const failure = await loadRuntimeBinding('/__pack/runtime-binding.json', (url) => call(url), { expected: command }).catch(error => error);
    expect(failure.code).toBe('pack-source-external-closure-mismatch');
    fail = false;
    expect((await call('/__pack/control/bind', { ...command, generation: 2 })).status).toBe(200);
    const ready = await call('/__pack/runtime-binding.json');
    expect(ready.status).toBe(200);
    const body = await ready.json(); expect(body.status).toBe('ready'); expect(body.diagnostic).toBeUndefined();
    current = { ...current, status: 'degraded', diagnostics: [{ code: 'fresh-failure', severity: 'blocking' }] };
    expect(await (await call('/__pack/runtime-binding.json')).json()).toMatchObject({ status: 'degraded' });
    expect(await (await call('/__pack/control/bind', { ...command, generation: 2 })).json()).toMatchObject({ status: 'degraded' });
    current = { ...current, status: 'ready', diagnostics: [] };
    expect(await (await call('/__pack/runtime-binding.json')).json()).toMatchObject({ status: 'ready', diagnostics: [] });
    const valid = current;
    current = { ...valid, gameId: 'other' };
    expect(await (await call('/__pack/runtime-binding.json')).json()).toMatchObject({ gameId: 'kart', status: 'ready' });
    current = valid; fail = true;
    expect((await call('/__pack/control/bind', { ...command, gameId: 'other', generation: 3 })).status).toBe(409);
    expect(await (await call('/__pack/runtime-binding.json')).json()).toMatchObject({ gameId: 'kart', generation: 2 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
