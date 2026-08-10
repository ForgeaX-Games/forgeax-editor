import { Component, Suspense, lazy } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { buildOperationCenterRows, getOperationProjectionSource, subscribeOperationProjection } from './operations/run-view-model';

const operationRuns = {
  getSnapshot: () => getOperationProjectionSource().getSnapshot(),
  subscribe: subscribeOperationProjection,
  retry: (runId: string) => {
    const source = getOperationProjectionSource();
    const run = source.getSnapshot().runs.find((candidate) => candidate.runId === runId);
    if (run === undefined) return;
    const row = buildOperationCenterRows([run], source.getCommits?.() ?? [], source.resolveAsset)[0];
    if (row !== undefined) source.dispatchRecovery?.('retry', row.runId, row);
  },
};

const ContentBrowser = lazy(() =>
  import('@forgeax/editor-content-browser').then(m => {
    console.info('[CB:import]', 'AssetsPanel.lazyLoad', {
      moduleUrl: import.meta.url,
      href: typeof location !== 'undefined' ? location.href : undefined,
    });
    return { default: m.ContentBrowser };
  })
);

class CBErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(e: Error) { return { error: e.message + '\n' + e.stack }; }
  componentDidCatch(e: Error, info: ErrorInfo) { console.error('[ContentBrowser]', e, info); }
  render() {
    if (this.state.error) return <div style={{ padding: 12, color: '#f88', whiteSpace: 'pre-wrap', fontSize: 11 }}>Content Browser error:\n{this.state.error}</div>;
    return this.props.children;
  }
}

export function AssetsPanel() {
  return (
    <CBErrorBoundary>
      <Suspense fallback={<div style={{ padding: 16, opacity: 0.5 }}>Loading Content Browser...</div>}>
        <ContentBrowser operationRuns={operationRuns} />
      </Suspense>
    </CBErrorBoundary>
  );
}
