// plan-strategy §7 M2 D-3: thin gateway shim — replaces the local history
// stack with a read from the session store (packages/core/src/store/cb-nav.ts)
// and dispatch through the singleton gateway.
//
// initialPath is accepted for API backward-compatibility but intentionally
// ignored: canonical state lives in the core session store (requirements §C6).
import { useCallback } from 'react';
import { gateway, useCBNav } from '@forgeax/editor-core';

export interface NavHistoryAPI {
  currentPath: string;
  canGoBack: boolean;
  canGoForward: boolean;
  navigate: (path: string) => void;
  goBack: () => void;
  goForward: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useNavHistory(_initialPath: string = ''): NavHistoryAPI {
  const { path, canGoBack, canGoForward } = useCBNav();

  const navigate = useCallback((p: string) => {
    gateway.dispatch({ kind: 'setCBPath', path: p });
  }, []);

  const goBack = useCallback(() => {
    gateway.dispatch({ kind: 'cbGoBack' });
  }, []);

  const goForward = useCallback(() => {
    gateway.dispatch({ kind: 'cbGoForward' });
  }, []);

  return { currentPath: path, canGoBack, canGoForward, navigate, goBack, goForward };
}
