import { resolve } from 'node:path';
import { existsSync, realpathSync, statSync } from 'node:fs';
import type { RuntimeAssetBinding } from '@forgeax/engine-types';
import { runtimeScopePath } from '@forgeax/engine-types';
import type { ForgeaXPackPlugin } from '@forgeax/engine-vite-plugin-pack';

interface RuntimeScopeCommand {
  readonly gameId: string;
  readonly scopeId: string;
  readonly generation: number;
  readonly gameDir: string;
}

export interface RuntimeScopeControllerOptions {
  readonly pack: ForgeaXPackPlugin;
  readonly base: string;
  readonly secret?: string;
  readonly initial?: RuntimeScopeCommand;
  readonly prepareGameMount?: (gameDir: string, gameId: string) => void | Promise<void>;
  readonly resolveRoots: (gameDir: string, gameId: string) => readonly string[];
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

/**
 * Own the Play sidecar's single active-game binding. The browser can observe
 * the binding, but only the server-side credentialed control route may change
 * the exact game directory and generation.
 */
export function createRuntimeScopeController(options: RuntimeScopeControllerOptions) {
  let serial = Promise.resolve();
  let lastGeneration = 0;

  const rebind = (command: RuntimeScopeCommand): Promise<RuntimeAssetBinding> => {
    const run = serial.then(async () => {
      if (command.generation <= lastGeneration) {
        throw new Error(`runtime generation ${command.generation} is not newer than ${lastGeneration}`);
      }
      await options.prepareGameMount?.(command.gameDir, command.gameId);
      const roots = options.resolveRoots(command.gameDir, command.gameId);
      const binding = await options.pack.rebind(makeBinding(command, options.base), roots);
      lastGeneration = command.generation;
      return binding;
    });
    serial = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    name: 'forgeax:runtime-scope-controller',
    configureServer(server: ViteServerLike) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (url === '/__pack/runtime-binding.json' && req.method !== 'POST') {
          const binding = options.pack.runtimeBinding();
          if (binding === undefined) {
            respond(res, 503, { error: 'runtime-scope-unbound', status: 'unbound' });
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
          respond(res, 409, {
            error: 'runtime-scope-bind-failed',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      });

      if (options.initial !== undefined) {
        void rebind(options.initial).catch((error) => {
          console.warn('[forgeax] initial runtime scope bind failed:', error);
        });
      }
    },
  };
}

export type { RuntimeScopeCommand };
