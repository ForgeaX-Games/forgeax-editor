import { VERSION_CONTROL_OPERATION_IDS, type VersionControlOperationId, type VersionControlSnapshot } from '@forgeax/editor-core';
import { useMemo, useState, type FormEvent } from 'react';
import { createVersionControlMenuModel, type VersionControlMenuActionId } from './menu-model';
import { VersionControlGraphView } from './graph';
import { initialVersionTarget, versionNodeTargetOptions } from './version-node';

export interface VersionControlOperationDescriptor {
  readonly id: VersionControlOperationId;
  readonly title?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly confirmation?: { readonly required: boolean; readonly reason?: string };
  readonly retry?: { readonly supported: boolean; readonly createsNewAttempt: boolean };
  readonly cancellation?: { readonly supported: boolean; readonly reason?: string };
  readonly recoveryActions?: readonly string[];
}

export interface VersionControlUiProjection {
  readonly snapshot: VersionControlSnapshot;
  readonly operations: readonly VersionControlOperationDescriptor[];
}

export type VersionControlDispatch = (
  operation: VersionControlOperationId,
  args: Record<string, unknown>,
  requestId: string,
) => Promise<unknown>;

export type VersionControlSnapshotRefresh = () => Promise<VersionControlSnapshot>;

export function projectVersionControlUi(
  snapshot: VersionControlSnapshot,
  listOps: readonly VersionControlOperationDescriptor[],
): VersionControlUiProjection {
  return { snapshot, operations: listOps };
}

export function createVersionControlRequest(
  kind: VersionControlOperationId,
  args: Record<string, unknown>,
  requestId: string,
): { readonly kind: VersionControlOperationId; readonly args: Record<string, unknown>; readonly requestId: string } {
  return { kind, args, requestId };
}

type ActiveDialog = VersionControlMenuActionId | null;
type ReadyVersionControlSnapshot = Extract<VersionControlSnapshot, { readonly status: 'ready' }>;

function requestId(): string {
  return `version-control-${crypto.randomUUID()}`;
}

export function VersionControlDialogs({
  snapshot,
  operations,
  dispatch,
  refreshSnapshot,
}: {
  readonly snapshot: VersionControlSnapshot;
  readonly operations: readonly VersionControlOperationDescriptor[];
  readonly dispatch: VersionControlDispatch;
  /** Re-read repository state from the Runtime Host before repository actions. */
  readonly refreshSnapshot?: VersionControlSnapshotRefresh;
}) {
  const model = useMemo(() => createVersionControlMenuModel(snapshot), [snapshot]);
  const targetOptions = useMemo(
    () => snapshot.status === 'ready' ? versionNodeTargetOptions(snapshot.graph.nodes, snapshot.currentTag, snapshot.head) : [],
    [snapshot],
  );
  const operationIds = new Set(operations.map((operation) => operation.id));
  const [active, setActive] = useState<ActiveDialog>(null);
  const [candidatePath, setCandidatePath] = useState('');
  const [tag, setTag] = useState('');
  const [message, setMessage] = useState('');
  const [targetCommit, setTargetCommit] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyReason, setBusyReason] = useState<'refreshing' | 'operation' | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const run = async (operation: VersionControlOperationId, args: Record<string, unknown>, close = true): Promise<void> => {
    // Capabilities arrive over the replaceable Runtime transport and may lag
    // the first paint. The canonical operation ids remain safe to dispatch;
    // the Runtime is the authority and returns a structured error if its
    // provider is not available.
    if ((!operationIds.has(operation) && !VERSION_CONTROL_OPERATION_IDS.includes(operation)) || busy) return;
    setBusy(true);
    setBusyReason('operation');
    setFeedback(null);
    try {
      await dispatch(operation, args, String(args.requestId ?? requestId()));
      if (close) setActive(null);
      setFeedback('Operation completed.');
    } catch (error) {
      const failure = error as { readonly hint?: unknown };
      setFeedback(typeof failure.hint === 'string' ? failure.hint : 'Version-control operation failed.');
    } finally {
      setBusy(false);
      setBusyReason(null);
    }
  };

  const inspectReadySnapshot = async (): Promise<ReadyVersionControlSnapshot | null> => {
    let current = snapshot;
    if (refreshSnapshot !== undefined) {
      setBusy(true);
      setBusyReason('refreshing');
      try {
        current = await refreshSnapshot();
      } catch {
        setFeedback('The latest repository status could not be read.');
        return null;
      } finally {
        setBusy(false);
        setBusyReason(null);
      }
    }
    if (current.status !== 'ready') {
      setFeedback(current.status === 'running' ? 'A version control operation is running.' : current.error.hint);
      return null;
    }
    return current;
  };

  const inspectPublishSnapshot = async (): Promise<ReadyVersionControlSnapshot | null> => {
    const current = await inspectReadySnapshot();
    if (current === null) return null;
    if (current.dirtyRecords.length === 0) {
      setFeedback('No changed files are available for publishing.');
      return null;
    }
    return current;
  };

  const inspectSwitchSnapshot = async (): Promise<ReadyVersionControlSnapshot | null> => {
    const current = await inspectReadySnapshot();
    if (current === null) return null;
    if (current.dirtyRecords.length > 0) {
      setFeedback('Publish or save all files before switching versions.');
      return null;
    }
    if (current.graph.nodes.length === 0) {
      setFeedback('No tagged or latest commit is available for switching.');
      return null;
    }
    return current;
  };

  const openAction = async (action: VersionControlMenuActionId): Promise<void> => {
    if (busy) return;
    setFeedback(null);
    let actionSnapshot = snapshot;
    if (action === 'publish-version') {
      const current = await inspectPublishSnapshot();
      if (current === null) return;
      actionSnapshot = current;
    } else if (action === 'switch-version') {
      const current = await inspectSwitchSnapshot();
      if (current === null) return;
      actionSnapshot = current;
    }
    setActive(action);
    if (action === 'switch-version' && actionSnapshot.status === 'ready') {
      const initial = initialVersionTarget(actionSnapshot.graph.nodes, actionSnapshot.currentTag, actionSnapshot.head);
      setTag(initial.tag);
      setTargetCommit(initial.commit);
    }
  };

  const submitSettings = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const id = requestId();
    await run('configureGitExecutable', candidatePath.trim() ? { candidatePath: candidatePath.trim(), requestId: id } : { requestId: id }, false);
  };

  const initialize = async (): Promise<void> => {
    const id = requestId();
    await run('initializeGameRepository', { requestId: id }, false);
  };

  const submitPublish = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const current = await inspectPublishSnapshot();
    if (current === null) return;
    const id = requestId();
    await run('publishGameVersion', {
      tag: tag.trim(),
      ...(message.trim() ? { message: message.trim() } : {}),
      expectedSnapshotId: current.snapshotId,
      ...(current.head ? { expectedCommit: current.head } : {}),
      requestId: id,
    });
  };

  const submitSwitch = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (snapshot.status !== 'ready') return;
    const id = requestId();
    await run('switchGameVersion', { tag: tag.trim(), expectedCommit: targetCommit, requestId: id });
  };

  return (
    <>
      <div className="fx-version-control-summary" data-status={snapshot.status}>
        <strong>{model.summary}</strong>
        <span>{model.reason}</span>
      </div>
      <div className="fx-version-control-menu" role="menu" aria-label="Version control menu">
        {model.actions.map((action) => (
          <button
            key={action.id}
            className={`fx-version-control-menu-action fx-version-control-menu-action-${action.id}`}
            type="button"
            role="menuitem"
            title={action.reason}
            disabled={!action.enabled || busy}
            onClick={() => { void openAction(action.id); }}
          >
            {action.label}
          </button>
        ))}
      </div>
      {busy ? (
        <div className="fx-version-control-state fx-version-control-progress" role="status" aria-live="polite">
          {busyReason === 'refreshing' ? 'Checking the latest repository status…' : 'Running version-control operation…'}
        </div>
      ) : null}
      {snapshot.status === 'ready' ? <VersionControlGraphView graph={snapshot.graph} currentTag={snapshot.currentTag} currentHead={snapshot.head} /> : null}
      {active === 'settings' ? (
        <section className="fx-version-control-dialog" aria-label="Version control settings">
          <h3>Git settings</h3>
          <form onSubmit={(event) => { void submitSettings(event); }}>
            <label>
              Git executable path
              <input value={candidatePath} onChange={(event) => setCandidatePath(event.target.value)} placeholder="Automatic detection" />
            </label>
            <div className="fx-version-control-dialog-actions">
              <button className="fx-version-control-button fx-version-control-button-primary" type="submit" disabled={busy}>{candidatePath.trim() ? 'Verify path' : 'Detect Git'}</button>
              <button className="fx-version-control-button fx-version-control-button-secondary" type="button" disabled={busy} onClick={() => { void initialize(); }}>Initialize repository</button>
            </div>
          </form>
          <p>Only a verified absolute executable path is saved. Git is not installed automatically. If detection fails, <a className="fx-version-control-install-git" href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">install Git</a> and run Detect Git again.</p>
        </section>
      ) : null}
      {active === 'publish-version' ? (
        <section className="fx-version-control-dialog" aria-label="Publish game version">
          <h3>Publish version</h3>
          {snapshot.status === 'ready' && snapshot.dirtyRecords.length > 0 ? (
            <ul
              className="fx-version-control-changes"
              aria-label={`${snapshot.dirtyRecords.length} changed files`}
              tabIndex={0}
            >
              {snapshot.dirtyRecords.map((record) => <li key={`${record.kind}:${record.path}`}>{record.kind}: {record.path}</li>)}
            </ul>
          ) : <p>No changed files are available for publishing.</p>}
          <form onSubmit={(event) => { void submitPublish(event); }}>
            <label>Tag<input required value={tag} onChange={(event) => setTag(event.target.value)} placeholder="release/1.0" /></label>
            <label>Message<textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Release notes" /></label>
            <div className="fx-version-control-dialog-actions">
              <button className="fx-version-control-button fx-version-control-button-primary" type="submit" disabled={busy || snapshot.status !== 'ready'}>Commit and tag</button>
              <button className="fx-version-control-button fx-version-control-button-secondary" type="button" disabled={busy} onClick={() => setActive(null)}>Cancel</button>
            </div>
          </form>
        </section>
      ) : null}
      {active === 'switch-version' ? (
        <section className="fx-version-control-dialog" aria-label="Switch game version">
          <h3>Switch version</h3>
          {snapshot.status === 'ready' ? (
            <>
              <label>Target
                <select value={tag} onChange={(event) => {
                  const next = targetOptions.find((option) => option.value === event.target.value);
                  setTag(event.target.value);
                  setTargetCommit(next?.commit ?? '');
                }}>
                  {targetOptions.map((option) => (
                    <option key={`${option.value}:${option.commit}`} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <p className="fx-version-control-target">Commit: {targetCommit || 'Select a target'}</p>
              <form onSubmit={(event) => { void submitSwitch(event); }}>
                <div className="fx-version-control-dialog-actions">
                  <button className="fx-version-control-button fx-version-control-button-primary" type="submit" disabled={busy || targetCommit.length !== 40}>Switch to target</button>
                  <button className="fx-version-control-button fx-version-control-button-secondary" type="button" disabled={busy} onClick={() => setActive(null)}>Cancel</button>
                </div>
              </form>
            </>
          ) : <p>{snapshot.status === 'running' ? 'Operation running.' : snapshot.error.hint}</p>}
        </section>
      ) : null}
      {feedback ? <div className="fx-version-control-feedback" role="status">{feedback}</div> : null}
      {snapshot.status === 'running' ? <div className="fx-version-control-state">Operation running</div> : null}
      {snapshot.status === 'recovery-required' ? <div className="fx-version-control-state">Recovery required: {snapshot.error.hint}</div> : null}
    </>
  );
}
