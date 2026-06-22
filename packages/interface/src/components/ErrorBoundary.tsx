import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '@/i18n';

interface Props {
  children: ReactNode;
  /** Optional label so nested boundaries identify which subtree failed. */
  scope?: string;
  /** When false, render a compact inline panel (for region-scoped boundaries
   *  inside a dock panel) instead of the full-screen overlay used at the root. */
  fullscreen?: boolean;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
  /** Bumped by "重载此区域" to force-remount the children subtree. */
  remountKey: number;
}

/**
 * RecoveryBoundary — a React error boundary with explicit recovery exits.
 *
 * A render throw anywhere in the subtree (a bad store selector, a plugin panel)
 * used to leave the shell stuck on a dead error page forever — fatal in the
 * Tauri desktop form, which has no address bar to reload from. This catches the
 * throw and offers three exits:
 *
 *   - 重试      — clears the error and re-renders the SAME element tree. Cheapest
 *                 recovery; works when the throw was a transient state glitch.
 *   - 重载此区域 — bumps a key so the children subtree fully remounts (fresh
 *                 component state), without reloading the whole window.
 *   - 重新加载 Studio — window.location.reload(); last resort, and the ONLY exit
 *                 a desktop (.app) user has since there's no browser chrome.
 *
 * This complements (does not overlap) the T2 iframe fatal banner: that one
 * handles failures *inside* the cross-origin engine iframe (device-lost / scene
 * instantiate); THIS one handles the shell's own React render crashing. The two
 * are different documents — a React boundary cannot see an iframe throw, and the
 * banner cannot see a shell render throw.
 *
 * Kept exported as both `RecoveryBoundary` (new name) and `ErrorBoundary`
 * (back-compat alias) so existing call sites need no churn.
 */
export class RecoveryBoundary extends Component<Props, State> {
  state: State = { error: null, info: null, remountKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ error, info });
    // Tear down the boot splash so the error is visible (it otherwise sits on
    // top of this fallback). Lossy by contract — ignored if absent.
    try {
      (window as unknown as { __forgeaxBoot?: { done(): void } }).__forgeaxBoot?.done();
    } catch {
      /* no-op */
    }
    // eslint-disable-next-line no-console
    console.error(`[RecoveryBoundary${this.props.scope ? ` · ${this.props.scope}` : ''}]`, error, info.componentStack);
  }

  /** 重试 — clear the error, re-render the same subtree (no remount). */
  private retry = (): void => {
    this.setState({ error: null, info: null });
  };

  /** 重载此区域 — clear the error AND bump the remount key so the subtree
   *  remounts with fresh component state. */
  private remountSubtree = (): void => {
    this.setState((s) => ({ error: null, info: null, remountKey: s.remountKey + 1 }));
  };

  /** 重新加载 Studio — hard reload of the whole window. */
  private reloadWindow = (): void => {
    try {
      window.location.reload();
    } catch {
      /* no-op */
    }
  };

  render(): ReactNode {
    const { error, info, remountKey } = this.state;
    const { scope, fullscreen = true } = this.props;
    if (!error) {
      // `key` forces a remount of the entire subtree when remountSubtree() bumps it.
      return <RemountScope key={remountKey}>{this.props.children}</RemountScope>;
    }

    const btn = (label: string, onClick: () => void, primary = false): ReactNode => (
      <button
        type="button"
        onClick={onClick}
        style={{
          font: '12px/1.4 ui-sans-serif, system-ui, sans-serif',
          padding: '6px 14px',
          borderRadius: 6,
          cursor: 'pointer',
          border: '1px solid var(--fx-border, #333)',
          background: primary ? 'var(--fx-accent, #4f7cff)' : 'var(--fx-bg-elev2, #1d1d1d)',
          color: primary ? '#fff' : 'var(--fx-fg, #eee)',
        }}
      >
        {label}
      </button>
    );

    const exits = (
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '0 0 16px' }}>
        {btn(t('errorBoundary.retry'), this.retry, true)}
        {btn(t('errorBoundary.reloadRegion'), this.remountSubtree)}
        {btn(t('errorBoundary.reloadStudio'), this.reloadWindow)}
      </div>
    );

    if (!fullscreen) {
      // Compact inline panel for region-scoped boundaries — keeps the rest of
      // the shell alive; only this dock region shows the recovery affordance.
      return (
        <div
          role="alert"
          style={{
            height: '100%',
            overflow: 'auto',
            padding: 16,
            background: 'var(--fx-bg, #0d0d0d)',
            color: 'var(--fx-fg, #fff)',
            font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
          }}
        >
          <div style={{ fontWeight: 600, color: 'var(--fx-danger, #f87171)', marginBottom: 6 }}>
            {t('errorBoundary.panelRenderError')}{scope ? ` · ${scope}` : ''}
          </div>
          <p style={{ margin: '0 0 12px', color: 'var(--fx-fg-muted, #aaa)' }}>
            {t('errorBoundary.panelHint')}
          </p>
          {exits}
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              padding: 12,
              borderRadius: 6,
              border: '1px solid var(--fx-border, #333)',
              background: 'var(--fx-bg-elev2, #161616)',
              color: 'var(--fx-danger, #f87171)',
            }}
          >
            {error.message}
          </pre>
        </div>
      );
    }

    return (
      <div
        role="alert"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 'var(--z-toplevel)',
          overflow: 'auto',
          padding: '32px',
          background: 'var(--fx-bg, #0d0d0d)',
          color: 'var(--fx-fg, #fff)',
          font: '13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      >
        <h1 style={{ margin: '0 0 8px', fontSize: 18, color: 'var(--fx-danger, #f87171)' }}>
          {t('errorBoundary.fullscreenTitle')}{scope ? ` · ${scope}` : ''}
        </h1>
        <p style={{ margin: '0 0 16px', color: 'var(--fx-fg-muted, #aaa)' }}>
          {t('errorBoundary.fullscreenHint')}
        </p>
        {exits}
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            padding: 16,
            borderRadius: 8,
            border: '1px solid var(--fx-border, #333)',
            background: 'var(--fx-bg-elev2, #161616)',
            color: 'var(--fx-danger, #f87171)',
          }}
        >
          {error.message}
          {'\n\n'}
          {error.stack}
          {info?.componentStack ? `\n\n--- component stack ---${info.componentStack}` : ''}
        </pre>
      </div>
    );
  }
}

/** Transparent wrapper whose only job is to carry the remount `key`. */
function RemountScope({ children }: { children: ReactNode }): ReactNode {
  return children;
}

/** Back-compat alias — existing imports use `ErrorBoundary`. */
export const ErrorBoundary = RecoveryBoundary;
