import { afterEach, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DiagnosticsSnapshot } from '@forgeax/editor-core';
import { CapabilitiesPanel } from '../Capabilities';
import {
  installDiagnosticsProjectionSource,
} from '../diagnostics/diagnostics-view-model';

function snapshot(): DiagnosticsSnapshot {
  return {
    schemaVersion: 'diagnostics/v1',
    revision: 4,
    trace: { roots: [], dropped: 0, deduplicated: 0 },
    scan: {
      diagnostics: [{ file: 'assets/broken.glb', severity: 'error', code: 'invalid-glb-header', message: 'replace source' }],
      dropped: 0,
      deduplicated: 0,
    },
    assets: { errors: [], dropped: 0, deduplicated: 0 },
    operationRuns: { runs: [], registryRevision: 0, dropped: 0, deduplicated: 0 },
    policy: {
      retention: { traceRoots: 64, scanDiagnostics: 128, assetErrors: 64, operationRuns: 64 },
      dedupe: {
        traceRoots: 'traceId',
        scanDiagnostics: 'file+severity+code+message+suggestion',
        assetErrors: 'op+path+hint',
        operationRuns: 'runId',
      },
    },
  };
}

afterEach(() => {
  // Restore the empty source so this static panel test cannot leak a fake host
  // into another panel test file in the same Bun process.
  const restore = installDiagnosticsProjectionSource({
    getSnapshot: () => ({
      ...snapshot(),
      revision: 0,
      scan: { diagnostics: [], dropped: 0, deduplicated: 0 },
    }),
  });
  restore();
});

describe('Capabilities diagnostics projection', () => {
  it('renders structured diagnostics controls and the host action surface', () => {
    const restore = installDiagnosticsProjectionSource({
      getSnapshot: snapshot,
      dispatchAction: () => {},
    });
    const html = renderToStaticMarkup(<CapabilitiesPanel />);
    restore();
    expect(html).toContain('cap-diagnostics');
    expect(html).toContain('cap-diagnostics-filter');
    expect(html).toContain('invalid-glb-header');
    expect(html).toContain('Locate');
    expect(html).toContain('Copy details');
    expect(html).toContain('Open source');
  });
});
