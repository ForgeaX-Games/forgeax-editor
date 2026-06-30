import { Component, Suspense, lazy } from 'react';
import type { ReactNode, ErrorInfo } from 'react';

const ContentBrowserV2 = lazy(() =>
  import('./content-browser/ContentBrowserV2').then(m => ({ default: m.ContentBrowserV2 }))
);

class CBErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(e: Error) { return { error: e.message + '\n' + e.stack }; }
  componentDidCatch(e: Error, info: ErrorInfo) { console.error('[ContentBrowserV2]', e, info); }
  render() {
    if (this.state.error) return <div style={{ padding: 12, color: '#f88', whiteSpace: 'pre-wrap', fontSize: 11 }}>Content Browser error:\n{this.state.error}</div>;
    return this.props.children;
  }
}

export function AssetsPanel() {
  return (
    <CBErrorBoundary>
      <Suspense fallback={<div style={{ padding: 16, opacity: 0.5 }}>Loading Content Browser...</div>}>
        <ContentBrowserV2 />
      </Suspense>
    </CBErrorBoundary>
  );
}
