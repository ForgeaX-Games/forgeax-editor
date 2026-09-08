import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createVersionControlRequest,
  projectVersionControlUi,
} from '../dialogs';

const dialogsSource = readFileSync(resolve(import.meta.dir, '../dialogs.tsx'), 'utf8');
const contributionSource = readFileSync(resolve(import.meta.dir, '../contribution.tsx'), 'utf8');
const contributionStyleSource = readFileSync(resolve(import.meta.dir, '../contribution.css'), 'utf8');
const graphSource = readFileSync(resolve(import.meta.dir, '../graph.tsx'), 'utf8');
const versionNodeSource = readFileSync(resolve(import.meta.dir, '../version-node.ts'), 'utf8');

describe('version control UI projection', () => {
  it('projects snapshot and catalog descriptors without a private capability table', () => {
    const snapshot = { generation: 2, status: 'ready', snapshotId: 'snapshot-2', dirtyRecords: [] } as never;
    const descriptors = [
      { id: 'configureGitExecutable', title: 'Configure Git' },
      { id: 'initializeGameRepository', title: 'Initialize repository' },
      { id: 'publishGameVersion', title: 'Publish version' },
      {
        id: 'switchGameVersion',
        title: 'Switch version',
        confirmation: { required: true, reason: 'Repository state changes.' },
        retry: { supported: true, createsNewAttempt: true },
        cancellation: { supported: false },
        recoveryActions: ['version-control.refresh', 'run.wait', 'run.retry'],
      },
    ] as never;
    const projection = projectVersionControlUi(snapshot, descriptors);
    expect(projection.snapshot).toBe(snapshot);
    expect(projection.operations).toBe(descriptors);
    expect(projection.operations[3]).toMatchObject({
      confirmation: { required: true },
      retry: { supported: true, createsNewAttempt: true },
      cancellation: { supported: false },
      recoveryActions: ['version-control.refresh', 'run.wait', 'run.retry'],
    });
  });

  it('normalizes UI requests to the same operation kind, args, and request id', () => {
    expect(createVersionControlRequest('publishGameVersion', { tag: 'playtest/a' }, 'request-1')).toEqual({
      kind: 'publishGameVersion',
      args: { tag: 'playtest/a' },
      requestId: 'request-1',
    });
  });

  it('does not access Host mutation or error text from the UI layer', () => {
    expect(dialogsSource).toContain('listOps');
    expect(dialogsSource).toContain('dispatch');
    expect(dialogsSource).toContain('refreshSnapshot');
    expect(dialogsSource).toContain('inspectSwitchSnapshot');
    expect(dialogsSource).toContain('Publish or save all files before switching versions.');
    expect(dialogsSource).toContain('Checking the latest repository status');
    expect(dialogsSource).toContain('aria-live="polite"');
    expect(dialogsSource).toContain("disabled={busy || snapshot.status !== 'ready'}");
    expect(contributionSource).not.toContain('setInterval');
    expect(contributionSource).toContain("kind: 'version-control.snapshot',");
    expect(contributionSource).toContain('refresh: true');
    expect(contributionStyleSource).toContain('overflow-y: auto');
    expect(contributionStyleSource).toContain('max-height: min(220px, 35vh)');
    expect(dialogsSource).toContain('versionNodeTargetOptions');
    expect(versionNodeSource).toContain('(current)');
    expect(dialogsSource).toContain('currentTag');
    expect(dialogsSource).toContain('VersionControlGraphView graph={snapshot.graph} currentTag={snapshot.currentTag} currentHead={snapshot.head}');
    expect(graphSource).toContain('navigator.clipboard');
    expect(graphSource).toContain('head.slice(0, 8)');
    expect(graphSource).toContain('window.setTimeout');
    expect(graphSource).not.toContain("data-copied={copied ? 'true' : undefined}");
    expect(graphSource).toContain('versionNodeTreeRows');
    expect(graphSource).toContain('versionNodeTreeEdges');
    expect(graphSource).toContain('<svg');
    expect(graphSource).toContain('fx-version-graph-connection');
    expect(graphSource).toContain('role="tree"');
    expect(contributionStyleSource).toContain('max-height: min(320px, 42vh)');
    expect(contributionStyleSource).toContain('overflow-x: hidden');
    expect(contributionStyleSource).toContain('.fx-version-graph-node.is-current');
    expect(contributionStyleSource).toContain('border-left-color: transparent');
    expect(graphSource).toContain('is-current');
    expect(contributionStyleSource).toContain('.fx-version-control-install-git');
    expect(contributionStyleSource).toContain('--color-brand-primary');
    expect(contributionStyleSource).toContain('.fx-version-control-button-primary');
    expect(contributionStyleSource).not.toContain('.fx-version-control-menu-action-publish-version');
    expect(contributionStyleSource).not.toContain('.fx-version-control-menu-action-switch-version');
    expect(contributionStyleSource).toContain('cursor: pointer;');
    expect(contributionStyleSource).not.toContain('cursor: copy;');
    expect(contributionStyleSource).not.toContain("[data-copied='true']");
    expect(dialogsSource).not.toMatch(/fetch\s*\(/);
    expect(dialogsSource).not.toContain('/api/');
    expect(dialogsSource).not.toMatch(/stderr|error\.message/);
    expect(dialogsSource).not.toMatch(/\.set\s*\(|world\.|store\//);
  });
});
