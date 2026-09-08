import {
  dispatchViewportRuntimeOperation,
  discoverViewportRuntimeCapabilities,
  queryViewportRuntimeProjection,
  type VersionControlSnapshot,
} from '@forgeax/editor-core';
import type { StatusItemContribution } from '@forgeax/interface/core/panels';
import type { AppExtension } from '@forgeax/interface/core/app-shell/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StripPopover } from '@forgeax/interface/components/StatusBar/StripPopover';
import { createVersionControlMenuModel } from './menu-model';
import { VersionControlDialogs, type VersionControlOperationDescriptor } from './dialogs';
import './contribution.css';

const unavailable = (generation: number): VersionControlSnapshot => ({
  generation,
  status: 'unavailable',
  error: { code: 'version-control-unavailable', hint: 'The version control Runtime is unavailable.' } as never,
});

async function readSnapshot(refresh = false): Promise<VersionControlSnapshot> {
  try {
    const envelope = await queryViewportRuntimeProjection<VersionControlSnapshot>({
      kind: 'version-control.snapshot',
      ...(refresh ? { refresh: true } : {}),
    });
    if (envelope.status === 'ready') return envelope.value;
    const generation = envelope.runtime.runtimeGeneration;
    if (envelope.status === 'unavailable' || envelope.status === 'faulted') {
      return { generation, status: envelope.status === 'faulted' ? 'faulted' : 'unavailable', error: envelope.error as never };
    }
    return unavailable(generation);
  } catch {
    return unavailable(0);
  }
}

async function listOperations(): Promise<readonly VersionControlOperationDescriptor[]> {
  try {
    const capabilities = await discoverViewportRuntimeCapabilities();
    return capabilities
      .filter((capability) => capability.subject === 'editor' && capability.kind === 'operation')
      .filter((capability) => (
        capability.verb === 'configureGitExecutable'
        || capability.verb === 'initializeGameRepository'
        || capability.verb === 'publishGameVersion'
        || capability.verb === 'switchGameVersion'
      ))
      .map((capability) => ({
        id: capability.verb as VersionControlOperationDescriptor['id'],
        title: capability.verb,
        inputSchema: capability.inputSchema as Record<string, unknown> | undefined,
        ...(capability.confirmation === undefined ? {} : { confirmation: capability.confirmation }),
        ...(capability.retry === undefined ? {} : { retry: capability.retry }),
        ...(capability.cancellation === undefined ? {} : { cancellation: capability.cancellation }),
        recoveryActions: capability.recoveryActions,
      }));
  } catch {
    return [];
  }
}

async function waitForVersionControlGeneration(previousGeneration: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const envelope = await queryViewportRuntimeProjection<VersionControlSnapshot>({ kind: 'version-control.snapshot' });
      if (envelope.status === 'ready' && envelope.value.generation > previousGeneration) return;
    } catch (error) {
      // The old MessagePort is deliberately disposed during the handoff. Keep
      // polling until the shell binds the cold successor or the timeout turns
      // this into a structured UI failure.
      lastError = error;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('The successor Runtime did not become ready after switching versions.');
}

function VersionControlChip() {
  const [snapshot, setSnapshot] = useState<VersionControlSnapshot>(() => unavailable(0));
  const [operations, setOperations] = useState<readonly VersionControlOperationDescriptor[]>([]);
  const refreshSequence = useRef(0);
  const disposed = useRef(false);
  const refreshSnapshot = useCallback(async (): Promise<VersionControlSnapshot> => {
    const sequence = ++refreshSequence.current;
    const next = await readSnapshot(true);
    if (!disposed.current && sequence === refreshSequence.current) setSnapshot(next);
    return next;
  }, []);

  useEffect(() => {
    disposed.current = false;
    void refreshSnapshot();
    void listOperations().then((nextOperations) => {
      if (!disposed.current) setOperations(nextOperations);
    });
    return () => {
      disposed.current = true;
      refreshSequence.current += 1;
    };
  }, [refreshSnapshot]);

  const model = useMemo(() => createVersionControlMenuModel(snapshot), [snapshot]);
  return (
    <StripPopover
      icon="GitBranch"
      label="Version control"
      tooltip="Version control"
      title={<><span aria-hidden="true">◆</span> Version control</>}
    >
      <VersionControlDialogs
        snapshot={snapshot}
        operations={operations}
        refreshSnapshot={refreshSnapshot}
        dispatch={async (operation, args, requestId) => {
          const previousGeneration = snapshot.generation;
          // Switching tears down the current carrier by design. Return the
          // transport acceptance before teardown, then let the shell observe
          // the successor generation through its newly bound client.
          const response = await dispatchViewportRuntimeOperation(
            operation,
            { ...args, requestId },
            undefined,
            operation === 'switchGameVersion' ? { async: true } : undefined,
          );
          if (response.error !== undefined) throw response.error;
          if (operation === 'switchGameVersion') await waitForVersionControlGeneration(previousGeneration);
          // Operations refresh the Runtime-owned provider cache as part of
          // their completion. Pull that event result into the status bar once;
          // this keeps the chip current without reintroducing a timer.
          await refreshSnapshot();
        }}
      />
      <span className="fx-version-control-sr-only">{model.reason}</span>
    </StripPopover>
  );
}

export const versionControlStatusItem: StatusItemContribution = {
  kind: 'status-item',
  id: 'version-control',
  location: 'statusbar.left',
  priority: 1000,
  item: { type: 'custom', render: () => <VersionControlChip /> },
};

export const versionControlStatusBarExtension: AppExtension = {
  id: 'edit-runtime.version-control-statusbar',
  version: '1.0.0',
  contributes: { panels: { stripItems: { [versionControlStatusItem.id]: versionControlStatusItem } } },
};
