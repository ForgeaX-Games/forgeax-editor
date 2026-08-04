import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SourceMutationDialog } from './SourceMutationDialog';
import { createSourceMutationViewModel, type SourceMutationViewModelInput } from './source-mutation-view-model';

try { GlobalRegistrator.register(); } catch { /* another content-browser DOM test already registered it */ }
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const input: SourceMutationViewModelInput = {
  guid: 'asset-guid',
  sourceKey: 'mesh:0',
  lifecycle: 'failed',
  lastKnownGood: 'current:0',
  impact: {
    scope: { all: true },
    sourceKeys: ['mesh:0', 'material:0'],
    affectedGuids: ['asset-guid', 'dependency-guid'],
    referencerGuids: ['scene-guid'],
    instanceGuids: [],
    expectedRevision: 'meta:4',
  },
  operation: {
    status: 'failed',
    error: {
      code: 'asset-publish-observation-timeout',
      phase: 'publication',
      hint: 'Reconcile before retrying.',
      recoveryActions: ['catalog.reconcile', 'run.retry'],
    },
  },
  confirmation: undefined,
  now: 100,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SourceMutationDialog', () => {
  it('shows impact, LKG, structured recovery, and separate reimport/discard actions', () => {
    const viewModel = createSourceMutationViewModel(input);
    const dispatched: string[] = [];
    act(() => root.render(<SourceMutationDialog viewModel={viewModel} onAction={(action) => dispatched.push(action)} />));
    expect(container.textContent).toContain('asset-guid');
    expect(container.textContent).toContain('mesh:0, material:0');
    expect(container.textContent).toContain('asset-guid, dependency-guid');
    expect(container.textContent).toContain('scene-guid');
    expect(container.textContent).toContain('current:0');
    expect(container.textContent).toContain('asset-publish-observation-timeout');
    expect(container.textContent).toContain('catalog.reconcile');
    expect(container.querySelector('[data-testid="source-reimport"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="source-discard"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="source-discard"]')?.hasAttribute('disabled')).toBe(true);
    expect(dispatched).toEqual([]);
  });
});
