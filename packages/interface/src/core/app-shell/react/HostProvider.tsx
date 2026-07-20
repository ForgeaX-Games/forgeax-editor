// packages/interface/src/core/app-shell/react/HostProvider.tsx
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { AppHost } from '../types';

const HostContext = createContext<AppHost | null>(null);

export const HostProvider: React.FC<{ value: AppHost; children: React.ReactNode }> = ({ value, children }) => {
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
};

export function useHost(): AppHost {
  const host = useContext(HostContext);
  if (!host) throw new Error('[app-shell] useHost() called outside <HostProvider>');
  return host;
}

export function useCommand<Args = unknown, R = unknown>(id: string): (args?: Args) => Promise<R> {
  const host = useHost();
  return useCallback((args?: Args) => host.commands.execute<R>(id, args as unknown), [host, id]);
}

export function useContextKey<T>(key: string): T | undefined {
  const host = useHost();
  const [value, setValue] = useState<T | undefined>(() => host.contextKeys.get<T>(key));
  useEffect(() => {
    // Re-read on effect-flush to close the render-vs-subscribe race: a
    // synchronous contextKeys.set() during first-render commit would be
    // missed if we only trusted the initial useState value.
    setValue(host.contextKeys.get<T>(key));
    const off = host.contextKeys.onChange(key, (v) => setValue(v as T));
    // Wrap in a void-returning arrow so useEffect's EffectCallback type is
    // satisfied — Cleanup allows void|Promise<void>, EffectCallback does not.
    return () => { void off(); };
  }, [host, key]);
  return value;
}
