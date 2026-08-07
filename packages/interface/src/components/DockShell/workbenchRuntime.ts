import { useCallback, useEffect, useState } from 'react';
import {
  createWorkbenchBrowserClient,
  type WorkbenchCatalogEntry,
  type WorkbenchFetch,
} from '@forgeax/workbench-host/browser';

export const WORKBENCH_API_BASE = '/__workbench__/v1/';
const WORKBENCH_HOST_EXTENSION_IDS = new Set([
  '@forgeax-extension/wb-game-video',
]);

const catalogRequests = new Map<string, Promise<readonly WorkbenchCatalogEntry[]>>();

export function isWorkbenchHostExtension(extensionId: string): boolean {
  return WORKBENCH_HOST_EXTENSION_IDS.has(extensionId);
}

export async function loadWorkbenchCatalog(
  gameId: string,
  fetcher?: WorkbenchFetch,
  signal?: AbortSignal,
): Promise<WorkbenchCatalogEntry[]> {
  return createWorkbenchBrowserClient({
    baseUrl: WORKBENCH_API_BASE,
    gameId,
    ...(fetcher ? { fetch: fetcher } : {}),
  }).catalog(signal);
}

/** A Page can mount left and center placements for the same extension. Keep the
 * catalog request shared so both panels resolve one authoritative runtime. */
export function loadSharedWorkbenchCatalog(
  gameId: string,
  fetcher?: WorkbenchFetch,
): Promise<readonly WorkbenchCatalogEntry[]> {
  const current = catalogRequests.get(gameId);
  if (current) return current;

  const request = loadWorkbenchCatalog(gameId, fetcher).catch((error: unknown) => {
    if (catalogRequests.get(gameId) === request) catalogRequests.delete(gameId);
    throw error;
  });
  catalogRequests.set(gameId, request);
  return request;
}

export function invalidateWorkbenchCatalog(gameId?: string): void {
  if (gameId) catalogRequests.delete(gameId);
  else catalogRequests.clear();
}

interface WorkbenchRuntimeState {
  readonly descriptor: WorkbenchCatalogEntry | null;
  readonly loading: boolean;
  readonly error: Error | null;
}

export function useWorkbenchCatalogEntry(
  extensionId: string,
  gameId: string | null,
  gameResolved: boolean,
): WorkbenchRuntimeState & { readonly retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<WorkbenchRuntimeState>({
    descriptor: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!gameResolved) {
      setState({ descriptor: null, loading: true, error: null });
      return;
    }
    if (!gameId) {
      setState({ descriptor: null, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState({ descriptor: null, loading: true, error: null });
    void loadSharedWorkbenchCatalog(gameId)
      .then((entries) => {
        if (cancelled) return;
        setState({
          descriptor: entries.find((entry) => entry.extensionId === extensionId) ?? null,
          loading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          descriptor: null,
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    return () => { cancelled = true; };
  }, [attempt, extensionId, gameId, gameResolved]);

  const retry = useCallback(() => {
    if (gameId) invalidateWorkbenchCatalog(gameId);
    setAttempt((value) => value + 1);
  }, [gameId]);

  return { ...state, retry };
}
