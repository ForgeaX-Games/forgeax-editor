import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  ApplicationRuntimeRoot,
  type ApplicationRuntime,
  type ApplicationRuntimeOwner,
} from '@forgeax/app-shell/application';
import { ApplicationRecoveryBoundary, type ApplicationRecoveryMessages } from '@forgeax/app-shell/react';

/** The window owns retirement above the replaceable render-recovery subtree. */
export function StandaloneRuntimeRoot<Runtime extends ApplicationRuntime>({
  createOwner, start, messages, shutdownMessages, revealError, reloadApplication, children,
}: {
  readonly createOwner: () => ApplicationRuntimeOwner;
  readonly start: () => Promise<Runtime>;
  readonly messages: ApplicationRecoveryMessages;
  readonly shutdownMessages: { readonly title: string; readonly hint: string; readonly retry: string };
  readonly revealError: () => void;
  readonly reloadApplication: () => void;
  readonly children: (runtime: Runtime) => ReactNode;
}): ReactNode {
  const [owner] = useState(createOwner);
  const shutdown = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  useEffect(() => {
    if (shutdown.status === 'blocked') {
      try { revealError(); } catch { /* Recovery must remain visible. */ }
    }
  }, [shutdown.status, revealError]);
  if (shutdown.status === 'blocked') {
    return <section role="alert" style={{ padding: 32 }}>
      <h1>{shutdownMessages.title}</h1>
      <p>{shutdownMessages.hint}</p>
      {shutdown.retryable ? <button type="button" data-testid="retry-shutdown"
        disabled={shutdown.retrying}
        onClick={() => { void owner.retryShutdown().catch(() => undefined); }}>
        {shutdownMessages.retry}
      </button> : null}
      <button type="button" onClick={reloadApplication}>{messages.reloadApplication}</button>
    </section>;
  }
  return <ApplicationRecoveryBoundary messages={messages} onRevealError={revealError}
    reloadApplication={reloadApplication} scope="standalone">
    <ApplicationRuntimeRoot owner={owner} start={start}>{children}</ApplicationRuntimeRoot>
  </ApplicationRecoveryBoundary>;
}
