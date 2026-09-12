import { handleProjectValidation } from '../../../scripts/host/project-validation';
import { createSourceAuthoringHandler } from '../../../scripts/host/source-authoring';
import { resolve } from 'node:path';
import { existsSync, realpathSync, statSync } from 'node:fs';
import type { RuntimeAssetBinding, RuntimeCatalogRoot } from '@forgeax/engine-types';
import { runtimeScopePath } from '@forgeax/engine-types';
import type { PluginPack } from '@forgeax/engine-vite-plugin-pack';

interface RuntimeScopeCommand {
  readonly gameId: string;
  readonly scopeId: string;
  readonly generation: number;
  readonly gameDir: string;
}

export interface RuntimeScopeMountTransition {
  commit(): void | Promise<void>;
  rollback(): void | Promise<void>;
}

export interface RuntimeScopeControllerOptions {
  readonly pack: PluginPack;
  readonly base: string;
  readonly secret?: string;
  readonly initial?: RuntimeScopeCommand;
  readonly prepareGameMount?: (
    gameDir: string,
    gameId: string,
  ) => void | RuntimeScopeMountTransition | Promise<void | RuntimeScopeMountTransition>;
  readonly resolveRoots: (gameDir: string, gameId: string) => readonly string[];
  readonly resolveProjectDdcRoot: (gameDir: string, gameId: string) => string;
  readonly resolveCatalogRoots: (gameDir: string, gameId: string) => readonly RuntimeCatalogRoot[];
}

interface ViteServerLike {
  readonly middlewares: {
    use(handler: (req: IncomingRequest, res: ServerResponse, next: () => void) => unknown): unknown;
  };
}

interface IncomingRequest {
  readonly url?: string;
  readonly method?: string;
  readonly headers?: Record<string, string | string[] | undefined>;
  on?: (event: 'data' | 'end' | 'error', listener: (...args: any[]) => void) => void;
}

interface ServerResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

function basePath(base: string, path: string): string {
  const prefix = base.replace(/\/+$/, '');
  return `${prefix}${path}` || path;
}

function makeBinding(
  command: RuntimeScopeCommand,
  base: string,
  catalogRoots: readonly RuntimeCatalogRoot[],
): RuntimeAssetBinding {
  const identity = { scopeId: command.scopeId, generation: command.generation };
  return {
    schemaVersion: 'runtime-asset-binding-v1',
    gameId: command.gameId,
    scopeId: command.scopeId,
    generation: command.generation,
    status: 'transitioning',
    catalogUrl: basePath(base, runtimeScopePath(identity, 'catalog.json')),
    importUrlBase: basePath(base, runtimeScopePath(identity, 'import')),
    packageUrlBase: basePath(base, runtimeScopePath(identity, 'asset')),
    catalogRoots: catalogRoots.map((root) => ({ ...root })),
  };
}

function readHeader(req: IncomingRequest, name: string): string | undefined {
  const value = req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function readBody(req: IncomingRequest): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    if (typeof req.on !== 'function') {
      reject(new Error('request body stream unavailable'));
      return;
    }
    req.on('data', (chunk: unknown) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error: unknown) => reject(error));
  });
}

function parseCommand(raw: unknown): RuntimeScopeCommand {
  if (raw === null || typeof raw !== 'object') throw new Error('runtime scope command must be an object');
  const candidate = raw as Record<string, unknown>;
  const gameId = typeof candidate.gameId === 'string' ? candidate.gameId.trim() : '';
  const scopeId = typeof candidate.scopeId === 'string' ? candidate.scopeId.trim() : '';
  const gameDir = typeof candidate.gameDir === 'string' ? candidate.gameDir.trim() : '';
  const generation = candidate.generation;
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(gameId)) throw new Error('invalid gameId');
  if (scopeId.length === 0 || scopeId.length > 256) throw new Error('invalid scopeId');
  if (
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) throw new Error('invalid generation');
  if (gameDir.length === 0 || !existsSync(resolve(gameDir)) || !statSync(resolve(gameDir)).isDirectory()) {
    throw new Error('gameDir must resolve to an existing directory');
  }
  return {
    gameId,
    scopeId,
    generation,
    gameDir: realpathSync.native(resolve(gameDir)),
  };
}

function respond(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function commandIdentity(command: RuntimeScopeCommand): string {
  return JSON.stringify([
    command.gameId,
    command.scopeId,
    command.generation,
    command.gameDir,
  ]);
}

function isReadyBinding(binding: RuntimeAssetBinding): boolean {
  return binding.status === 'ready' || binding.status === 'degraded';
}

function errorCode(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'runtime-scope-bind-failed';
}

function redactedBindError(error: unknown): {
  readonly error: 'runtime-scope-bind-failed';
  readonly code: string;
  readonly detail: string;
} {
  const code = errorCode(error);
  return {
    error: 'runtime-scope-bind-failed',
    code,
    detail: code,
  };
}

/**
 * Own the Play sidecar's single active-game binding. The browser can observe
 * the binding, but only the server-side credentialed control route may change
 * the exact game directory and generation.
 */
export function createRuntimeScopeController(options: RuntimeScopeControllerOptions) {
  let serial = Promise.resolve();
  let initialBind: Promise<RuntimeAssetBinding | undefined> | undefined;
  let initialBindError: unknown;
  let committed: { readonly identity: string; readonly binding: RuntimeAssetBinding; readonly gameDir: string } | undefined;
  const inFlight = new Map<string, Promise<RuntimeAssetBinding>>();
  const rebind = (command: RuntimeScopeCommand): Promise<RuntimeAssetBinding> => {
    const identity = commandIdentity(command);
    if (committed?.identity === identity) return Promise.resolve(committed.binding);
    const existing = inFlight.get(identity);
    if (existing !== undefined) return existing;

    const run = serial.then(async () => {
      if (committed?.identity === identity) return committed.binding;
      const currentGeneration = options.pack.runtimeBinding()?.generation;
      if (currentGeneration !== undefined && command.generation <= currentGeneration) {
        throw Object.assign(
          new Error(`runtime generation ${command.generation} is not newer than ${currentGeneration}`),
          { code: 'runtime-generation-stale' },
        );
      }
      const mountTransition = await options.prepareGameMount?.(command.gameDir, command.gameId);
      try {
        const roots = options.resolveRoots(command.gameDir, command.gameId);
        const projectDdcRoot = options.resolveProjectDdcRoot(command.gameDir, command.gameId);
        const catalogRoots = options.resolveCatalogRoots(command.gameDir, command.gameId);
        const binding = await options.pack.rebind(
          makeBinding(command, options.base, catalogRoots),
          roots,
          projectDdcRoot,
        );
        if (
          binding.gameId !== command.gameId
          || binding.scopeId !== command.scopeId
          || binding.generation !== command.generation
        ) {
          throw Object.assign(
            new Error('runtime rebind returned a binding for a different game generation'),
            { code: 'runtime-binding-mismatch' },
          );
        }
        if (!isReadyBinding(binding)) {
          throw new Error(`runtime generation ${command.generation} did not become ready (${binding.status})`);
        }
        await mountTransition?.commit();
        committed = { identity, gameDir: command.gameDir, binding };
        return binding;
      } catch (error) {
        try {
          await mountTransition?.rollback();
        } catch (rollbackError) {
          throw Object.assign(
            new AggregateError(
              [error, rollbackError],
              'runtime game mount rollback failed after bind failure',
            ),
            { code: 'runtime-mount-rollback-failed' },
          );
        }
        throw error;
      }
    });
    serial = run.then(() => undefined, () => undefined);
    inFlight.set(identity, run);
    void run.then(
      () => inFlight.delete(identity),
      () => inFlight.delete(identity),
    );
    return run;
  };

  return {
    name: 'forgeax:runtime-scope-controller',
    configureServer(server: ViteServerLike) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        const validationRequest = url === '/api/validation/project' || url === basePath(options.base, '/api/validation/project');
        if ((validationRequest || url === '/api/assets/source/execute' || url === basePath(options.base, '/api/assets/source/execute')) && req.method === 'POST') {
          // Queue with binding transitions; a stale viewport must never operate
          // on the directory of the next game, even during an async body read.
          const body = await readBody(req);
          const operation = serial.then(async () => {
            const scope = committed;
            if (!scope || readHeader(req, 'x-forgeax-game-id') !== scope.binding.gameId
              || readHeader(req, 'x-forgeax-scope-id') !== scope.binding.scopeId
              || readHeader(req, 'x-forgeax-generation') !== String(scope.binding.generation)) {
              respond(res, 409, { ok: false, error: {
                code: validationRequest ? 'project-validation-scope-stale' : 'source-authoring-scope-stale', retryable: false,
                hint: 'Reopen the current game before accessing its project sources.',
              } });
              return;
            }
            const request = new Request('http://editor-host' + url, { method: 'POST', body });
            const response = validationRequest
              ? await handleProjectValidation(scope.gameDir, request)
              : await createSourceAuthoringHandler(scope.gameDir)(request);
            respond(res, response.status, await response.json());
          });
          serial = operation.catch(() => undefined);
          try { await operation; } catch {
            respond(res, 500, { ok: false, error: { code: validationRequest ? 'project-validation-unavailable' : 'source-authoring-host-failed', retryable: false } });
          }
          return;
        }
        if (url === '/__pack/runtime-binding.json' && req.method !== 'POST') {
          // The Vite server can accept browser traffic before the first pack
          // scan has published its binding. Keep the probe attached to that
          // same promise instead of returning a transient `transitioning`
          // snapshot and making every consumer invent its own timeout.
          if (initialBind !== undefined) {
            await initialBind;
          }
          const binding = committed?.binding ?? options.pack.runtimeBinding();
          if (binding === undefined) {
            respond(res, 503, { error: 'runtime-scope-unbound', status: 'unbound' });
          } else if (
            initialBindError !== undefined
            && (binding.status === 'transitioning' || binding.status === 'unavailable')
          ) {
            respond(res, 503, { ...redactedBindError(initialBindError), status: binding.status });
          } else {
            respond(res, 200, binding);
          }
          return;
        }
        if (url !== '/__pack/control/bind') {
          next();
          return;
        }
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          respond(res, 405, { error: 'method-not-allowed' });
          return;
        }
        if (options.secret === undefined || readHeader(req, 'x-forgeax-runtime-secret') !== options.secret) {
          respond(res, 403, { error: 'runtime-scope-control-forbidden' });
          return;
        }
        try {
          const command = parseCommand(JSON.parse(await readBody(req)));
          respond(res, 200, await rebind(command));
        } catch (error) {
          respond(res, 409, redactedBindError(error));
        }
      });

      if (options.initial !== undefined) {
        initialBind = rebind(options.initial).catch((error) => {
          initialBindError = error;
          console.warn('[forgeax] initial runtime scope bind failed:', error);
          return undefined;
        });
      }
    },
  };
}

export type { RuntimeScopeCommand };
