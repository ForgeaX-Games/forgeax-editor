export const PLAY_CATALOG_MAX_WAIT_MS = 15_000;
export const PLAY_CATALOG_RETRY_DELAY_MS = 100;

export interface PlayCatalogOwner {
  refreshCatalog(): Promise<boolean>;
  listCatalog(): readonly { readonly guid: string }[];
}

export interface RefreshPlayCatalogOptions {
  readonly requiredGuid?: string;
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function catalogHasGuid(assets: PlayCatalogOwner, guid: string): boolean {
  const wanted = guid.toLowerCase();
  return assets.listCatalog().some((entry) => entry.guid.toLowerCase() === wanted);
}

/**
 * Engine preview refreshes the runtime catalog before loadByGuid(defaultScene).
 * Studio Play can bind while Pack is still rebuilding (stale-generation), so
 * refresh once, then retry until the required GUID appears or the deadline elapses.
 */
export async function refreshPlayCatalogUntilReady(
  assets: PlayCatalogOwner,
  options: RefreshPlayCatalogOptions = {},
): Promise<boolean> {
  const requiredGuid = options.requiredGuid?.trim();
  const timeoutMs = options.timeoutMs ?? PLAY_CATALOG_MAX_WAIT_MS;
  const retryDelayMs = options.retryDelayMs ?? PLAY_CATALOG_RETRY_DELAY_MS;
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const startedAt = now();

  while (true) {
    await assets.refreshCatalog();
    if (requiredGuid === undefined || requiredGuid.length === 0) return true;
    if (catalogHasGuid(assets, requiredGuid)) return true;
    const remaining = timeoutMs - (now() - startedAt);
    if (remaining <= 0) return false;
    await wait(Math.min(retryDelayMs, remaining));
  }
}
