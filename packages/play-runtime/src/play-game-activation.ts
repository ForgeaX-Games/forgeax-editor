import {
  gameHostPlugin,
  loadGame,
  type App,
  type GameHost,
  type Plugin,
} from '@forgeax/engine-app';
import type { World } from '@forgeax/engine-ecs';
import type { BootstrapContext, BootstrapEntry } from './types';

type LegacyApplyEntry = { apply(ctx?: unknown): void | Promise<void> };
export type LegacyPlayGameEntry = BootstrapEntry | LegacyApplyEntry;

export type PlayGameActivation =
  | { readonly kind: 'plugin'; readonly plugin: Plugin }
  | { readonly kind: 'legacy'; readonly entry: LegacyPlayGameEntry }
  | { readonly kind: 'none' };

function isNativeCordisPlugin(entry: unknown): entry is Plugin {
  return typeof entry === 'object'
    && entry !== null
    && Array.isArray((entry as { readonly inject?: unknown }).inject);
}

function normalizeLegacyGameEntry(module: unknown): LegacyPlayGameEntry | null {
  if (typeof module !== 'object' || module === null) return null;
  const record = module as { default?: unknown; bootstrap?: unknown };
  const candidate = record.default ?? record.bootstrap;
  if (typeof candidate === 'function') return candidate as BootstrapEntry;
  if (
    typeof candidate === 'object'
    && candidate !== null
    && typeof (candidate as { apply?: unknown }).apply === 'function'
  ) {
    return candidate as LegacyApplyEntry;
  }
  return null;
}

/**
 * Engine preview admits a game only through `loadGame` (default-export Cordis
 * plugin). Older Studio games still export `bootstrap(world, ctx)`; keep that
 * as a fallback after the engine contract fails.
 */
export async function resolvePlayGameActivation(
  slug: string,
  module: unknown,
): Promise<PlayGameActivation> {
  if (module === null || module === undefined) return { kind: 'none' };
  const loaded = await loadGame(slug, async () => module as { default?: unknown });
  if (loaded.ok) {
    if (typeof loaded.value === 'function') {
      return { kind: 'legacy', entry: loaded.value as BootstrapEntry };
    }
    return { kind: 'plugin', plugin: loaded.value };
  }
  const legacy = normalizeLegacyGameEntry(module);
  if (legacy === null) return { kind: 'none' };
  return { kind: 'legacy', entry: legacy };
}

export async function activatePlayGame(args: {
  readonly app: App;
  readonly world: World;
  readonly gameHost: GameHost;
  readonly ctx: BootstrapContext;
  readonly activation: PlayGameActivation;
}): Promise<void> {
  const { activation } = args;
  if (activation.kind === 'none') return;
  if (activation.kind === 'plugin') {
    await args.app.pluginContext.plugin(gameHostPlugin(args.gameHost));
    await args.app.pluginContext.plugin(activation.plugin);
    return;
  }
  if (typeof activation.entry === 'function') {
    await activation.entry(args.world, args.ctx);
    return;
  }
  if (isNativeCordisPlugin(activation.entry)) {
    await args.app.pluginContext.plugin(gameHostPlugin(args.gameHost));
    await args.app.pluginContext.plugin(activation.entry);
    return;
  }
  await activation.entry.apply(args.ctx);
}
