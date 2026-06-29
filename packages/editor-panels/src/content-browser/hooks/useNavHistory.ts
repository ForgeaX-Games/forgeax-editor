import { useCallback, useRef, useState } from 'react';
import type { CBNavEntry } from '../types';

export interface NavHistoryAPI {
  currentPath: string;
  canGoBack: boolean;
  canGoForward: boolean;
  navigate: (path: string) => void;
  goBack: () => void;
  goForward: () => void;
}

export function useNavHistory(initialPath: string = ''): NavHistoryAPI {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const historyRef = useRef<CBNavEntry[]>([{ path: initialPath, timestamp: Date.now() }]);
  const indexRef = useRef(0);

  const canGoBack = indexRef.current > 0;
  const canGoForward = indexRef.current < historyRef.current.length - 1;

  const navigate = useCallback((path: string) => {
    const history = historyRef.current;
    historyRef.current = history.slice(0, indexRef.current + 1);
    historyRef.current.push({ path, timestamp: Date.now() });
    indexRef.current = historyRef.current.length - 1;
    setCurrentPath(path);
  }, []);

  const goBack = useCallback(() => {
    if (indexRef.current > 0) {
      indexRef.current -= 1;
      setCurrentPath(historyRef.current[indexRef.current]!.path);
    }
  }, []);

  const goForward = useCallback(() => {
    if (indexRef.current < historyRef.current.length - 1) {
      indexRef.current += 1;
      setCurrentPath(historyRef.current[indexRef.current]!.path);
    }
  }, []);

  return { currentPath, canGoBack, canGoForward, navigate, goBack, goForward };
}
