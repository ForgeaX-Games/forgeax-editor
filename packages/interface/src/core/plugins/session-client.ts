// packages/interface/src/core/plugins/session-client.ts
//
// host.session capability — bridges the legacy useShellStore session slice so
// non-React callers (event handlers, module-level code, other plugins) can
// reach session state/methods through the AppHost instead of importing the
// store directly.
//
// This is a thin capability object, NOT a reactivity source: read-getters
// snapshot `useShellStore.getState()` on each access; components that need to
// re-render on session changes must keep subscribing to useShellStore. The
// per-callsite migration (and eventual slice deletion) lands in T24.

import type { AppPlugin } from '../app-shell/types';
import type { SessionClient } from '../../store-parts/session-client';
import type { ChatTab } from '../../store';
import { useShellStore } from '../../store';
import { getSessionClient, hasSessionClient } from '../../store-parts/session-client';

export interface SessionCapability {
  /** Low-level session client (REST + WS). Same instance
   *  `getSessionClient()` returns everywhere else. */
  readonly client: SessionClient;
  /** Snapshot of `useShellStore.getState().tabs`. */
  readonly tabs: readonly ChatTab[];
  /** Snapshot of `useShellStore.getState().activeSid`. */
  readonly activeSid: string | null;
  /** Snapshot of `useShellStore.getState().pinnedSlug`. */
  readonly pinnedSlug: string | null;

  switchToSession(sid: string): Promise<void>;
  /** Wraps `useShellStore.getState().createNewSession`. Returns `null` on
   *  failure to mirror the store's contract. */
  createSession(opts?: {
    displayName?: string;
    defaultDir?: string;
    providerOverride?: string | null;
  }): Promise<{ sid: string } | null>;
  closeSession(sid: string): Promise<void>;
  renameTab(sid: string, displayName: string): void;
  refreshSessions(): Promise<void>;
  switchGame(slug: string): Promise<void>;
}

export const sessionClientPlugin: AppPlugin = {
  id: 'session-client',
  version: '1.0.0',
  provides: ['session'],
  setup(ctx) {
    // Graceful degradation: interface-alone / standalone-editor hosts have no
    // forgeax-server, so the composition root never configures a client. Skip
    // providing host.session (consumers already narrow with `if (host.session)`)
    // instead of throwing the shell boot into console.error.
    if (!hasSessionClient()) {
      ctx.log.info('[session-client] no client configured — host.session skipped (studio-only capability)');
      return;
    }
    const client = getSessionClient();
    const cap: SessionCapability = {
      client,
      get tabs()       { return useShellStore.getState().tabs; },
      get activeSid()  { return useShellStore.getState().activeSid; },
      get pinnedSlug() { return useShellStore.getState().pinnedSlug; },
      switchToSession: (sid)     => useShellStore.getState().switchToSession(sid),
      createSession:   (opts)    => useShellStore.getState().createNewSession(opts),
      closeSession:    (sid)     => useShellStore.getState().closeSession(sid),
      renameTab:       (sid, n)  => useShellStore.getState().renameTab(sid, n),
      refreshSessions: ()        => useShellStore.getState().refreshSessions(),
      switchGame:      (slug)    => useShellStore.getState().switchGame(slug),
    };
    ctx.host.extend('session', cap);
  },
};
