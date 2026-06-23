import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Optional label so nested boundaries identify which subtree failed. */
  scope?: string;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

/**
 * Root error boundary. A render throw anywhere in the tree (e.g. a bad store
 * selector or a plugin panel) used to leave the boot splash stuck at 80% with a
 * blank shell. This catches the throw, dismisses the splash so the user is not
 * staring at a frozen loader, and shows the actual error + component stack so
 * the failure is diagnosable instead of silent.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

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
    console.error(`[ErrorBoundary${this.props.scope ? ` · ${this.props.scope}` : ''}]`, error, info.componentStack);
  }

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;
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
          React shell crashed{this.props.scope ? ` · ${this.props.scope}` : ''}
        </h1>
        <p style={{ margin: '0 0 16px', color: 'var(--fx-fg-muted, #aaa)' }}>
          界面渲染时抛错。下方是真实错误与组件栈；修复后热更新即可恢复。
        </p>
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
