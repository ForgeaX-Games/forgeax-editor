import {
  broadcastAssetsChanged,
  createAuthoringToolClientTransport,
  createProjectAuthoringGatewayProjection,
  dispatchAndWaitActiveEditorOperation,
  type AuthoringToolClientTransport,
} from '@forgeax/editor-core';
import { readRuntimeAssetCatalog } from './runtime-asset-catalog';

export interface MeshAuthoringFailure {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
  readonly retryable?: boolean;
  readonly recoveryActions?: readonly string[];
}

/**
 * A UI projection must not collapse the Project ToolPlugin failure contract
 * into an opaque Error message.  The message remains useful for the existing
 * toast path, while callers and tests can inspect the same machine fields the
 * ToolClient returned.
 */
export class MeshAuthoringError extends Error implements MeshAuthoringFailure {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
  readonly retryable?: boolean;
  readonly recoveryActions?: readonly string[];

  constructor(failure: MeshAuthoringFailure) {
    super(failure.hint);
    this.name = 'MeshAuthoringError';
    this.code = failure.code;
    this.expected = failure.expected;
    this.hint = failure.hint;
    this.detail = failure.detail;
    this.retryable = failure.retryable;
    this.recoveryActions = failure.recoveryActions;
  }
}

function meshAuthoringError(
  failure: Partial<MeshAuthoringFailure> & Pick<MeshAuthoringFailure, 'hint'>,
  fallback: Pick<MeshAuthoringFailure, 'code' | 'expected'>,
): MeshAuthoringError {
  return new MeshAuthoringError({
    code: typeof failure.code === 'string' ? failure.code : fallback.code,
    expected: typeof failure.expected === 'string' ? failure.expected : fallback.expected,
    hint: failure.hint,
    ...(Object.hasOwn(failure, 'detail') ? { detail: failure.detail } : {}),
    ...(typeof failure.retryable === 'boolean' ? { retryable: failure.retryable } : {}),
    ...(Array.isArray(failure.recoveryActions) ? { recoveryActions: failure.recoveryActions } : {}),
  });
}

function fromFailure(
  failure: unknown,
  fallback: Pick<MeshAuthoringFailure, 'code' | 'expected' | 'hint'>,
): MeshAuthoringError {
  if (failure !== null && typeof failure === 'object') {
    const value = failure as Partial<MeshAuthoringFailure>;
    return meshAuthoringError(
      {
        ...(typeof value.code === 'string' ? { code: value.code } : {}),
        ...(typeof value.expected === 'string' ? { expected: value.expected } : {}),
        hint: typeof value.hint === 'string' ? value.hint : fallback.hint,
        ...(Object.hasOwn(value, 'detail') ? { detail: value.detail } : {}),
        ...(typeof value.retryable === 'boolean' ? { retryable: value.retryable } : {}),
        ...(Array.isArray(value.recoveryActions) ? { recoveryActions: value.recoveryActions } : {}),
      },
      fallback,
    );
  }
  return new MeshAuthoringError(fallback);
}

interface SlotRecord extends Record<string, unknown> {
  readonly slotName: string;
  readonly sourceKey?: string;
}

/**
 * ToolClient revisions are content digests, while the Editor source
 * operation boundary consumes the exact strong ETag representation returned
 * by the file resource port. Preserve an existing quoted value and quote a
 * bare digest so the same snapshot can safely cross both boundaries.
 */
function editorRevision(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value : JSON.stringify(value);
}

function slotsOf(override: Record<string, unknown>): SlotRecord[] {
  const raw = override.materialSlots;
  if (!Array.isArray(raw)) {
    throw new MeshAuthoringError({
      code: 'mesh-source-topology-missing',
      expected: 'the imported Mesh source override to publish materialSlots',
      hint: 'The imported Mesh publishes no materialSlots source override.',
      detail: { field: 'materialSlots' },
      retryable: false,
      recoveryActions: ['authoring.snapshot.read'],
    });
  }
  return raw.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || typeof (entry as { slotName?: unknown }).slotName !== 'string') {
      throw new MeshAuthoringError({
        code: 'mesh-source-topology-invalid',
        expected: 'each imported Mesh material slot to include a slotName',
        hint: 'The imported Mesh materialSlots source override is malformed.',
        detail: { field: 'materialSlots' },
        retryable: false,
        recoveryActions: ['authoring.snapshot.read'],
      });
    }
    return { ...(entry as SlotRecord) };
  });
}

export function patchMeshMaterialSlotDefault(
  override: Record<string, unknown>,
  identity: { readonly slotName: string; readonly sourceKey?: string },
  authoredDefaultMaterialGuid: string | null | undefined,
): Record<string, unknown> {
  const slots = slotsOf(override);
  const index = slots.findIndex((slot) => (
    identity.sourceKey !== undefined && slot.sourceKey === identity.sourceKey
  ) || (identity.sourceKey === undefined && slot.slotName === identity.slotName));
  if (index < 0) {
    throw new MeshAuthoringError({
      code: 'mesh-slot-not-found',
      expected: `the imported Mesh source override to contain slot ${identity.slotName}`,
      hint: `Material slot "${identity.slotName}" is absent from the source override.`,
      detail: { slotName: identity.slotName, ...(identity.sourceKey === undefined ? {} : { sourceKey: identity.sourceKey }) },
      retryable: false,
      recoveryActions: ['authoring.snapshot.read'],
    });
  }
  const selected = slots[index] as SlotRecord;
  const identityKey = selected.sourceKey ?? selected.slotName;
  const current = override.materialSlotDefaultOverrides;
  const defaults = current !== null && typeof current === 'object' && !Array.isArray(current)
    ? { ...(current as Record<string, unknown>) }
    : {};
  if (authoredDefaultMaterialGuid === undefined) delete defaults[identityKey];
  else defaults[identityKey] = authoredDefaultMaterialGuid;
  const next: Record<string, unknown> = { ...override, materialSlots: slots };
  if (Object.keys(defaults).length === 0) delete next.materialSlotDefaultOverrides;
  else next.materialSlotDefaultOverrides = defaults;
  return next;
}

async function readSourceSnapshot(transport: AuthoringToolClientTransport, meshGuid: string): Promise<{
  readonly revision: string;
  readonly override: Record<string, unknown>;
  readonly sourceKey: string;
}> {
  const terminal = await transport.run({
    operationId: 'authoring.snapshot.read',
    args: { subject: { kind: 'mesh', guid: meshGuid } },
  });
  if ('ok' in terminal) {
    throw fromFailure(terminal.error, {
      code: 'authoring-snapshot-failed',
      expected: 'the Project authoring snapshot to be readable',
      hint: 'Project authoring snapshot failed.',
    });
  }
  if (terminal.outcome !== 'succeeded') {
    throw fromFailure(terminal.failure, {
      code: 'authoring-snapshot-failed',
      expected: 'the Project authoring snapshot to be readable',
      hint: 'Project authoring snapshot failed.',
    });
  }
  const result = terminal.result;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new MeshAuthoringError({
      code: 'authoring-snapshot-invalid',
      expected: 'the Project authoring snapshot to return a structured result',
      hint: 'Project authoring snapshot returned no structured result.',
      detail: { operationId: 'authoring.snapshot.read' },
      retryable: true,
      recoveryActions: ['authoring.snapshot.read'],
    });
  }
  const value = result as {
    readonly revision?: unknown;
    readonly state?: unknown;
    readonly identity?: { readonly sourceKey?: unknown };
  };
  if (typeof value.revision !== 'string' || value.state === null || typeof value.state !== 'object' || Array.isArray(value.state)
    || typeof value.identity?.sourceKey !== 'string') {
    throw new MeshAuthoringError({
      code: 'authoring-snapshot-invalid',
      expected: 'the Project authoring snapshot to include revision, state, and source identity',
      hint: 'Project authoring snapshot is missing revision, state, or source identity.',
      detail: { operationId: 'authoring.snapshot.read' },
      retryable: true,
      recoveryActions: ['authoring.snapshot.read'],
    });
  }
  return {
    revision: editorRevision(value.revision),
    sourceKey: value.identity.sourceKey,
    override: { ...(value.state as Record<string, unknown>) },
  };
}

/** Save one imported Mesh slot through the Project ToolPlugin source transaction. */
export async function saveMeshMaterialSlotDefault(input: {
  readonly meshGuid: string;
  readonly slotName: string;
  readonly slotSourceKey?: string;
  readonly materialGuid?: string | null;
  readonly transport?: AuthoringToolClientTransport;
}): Promise<void> {
  const catalog = await readRuntimeAssetCatalog();
  const row = catalog.find((entry) => entry.guid.toLowerCase() === input.meshGuid.toLowerCase());
  if (row?.sourceKey === undefined) {
    throw new MeshAuthoringError({
      code: 'mesh-source-read-only',
      expected: 'the Mesh Runtime catalog to expose an imported source identity',
      hint: 'This Mesh has no imported source identity, so its defaults are read-only.',
      detail: { meshGuid: input.meshGuid },
      retryable: false,
      recoveryActions: ['assets.catalog.refresh'],
    });
  }
  const sourceKey = row.sourceKey;
  const transport = input.transport ?? createAuthoringToolClientTransport();
  const source = await readSourceSnapshot(transport, input.meshGuid);
  if (source.sourceKey !== sourceKey) {
    throw new MeshAuthoringError({
      code: 'mesh-source-identity-mismatch',
      expected: 'the Project snapshot source identity to match the Runtime Mesh catalog',
      hint: 'Project authoring snapshot identity does not match the Runtime Mesh catalog.',
      detail: { catalogSourceKey: sourceKey, snapshotSourceKey: source.sourceKey },
      retryable: true,
      recoveryActions: ['assets.catalog.refresh', 'authoring.snapshot.read'],
    });
  }
  const current = source.override;

  if (typeof input.materialGuid === 'string') {
    const accepted = catalog.some(
      (entry) => entry.guid.toLowerCase() === input.materialGuid!.toLowerCase()
        && entry.kind === 'material',
    );
    if (!accepted) {
      throw new MeshAuthoringError({
        code: 'mesh-material-incompatible',
        expected: 'the selected default to identify a MaterialAsset in the Runtime catalog',
        hint: 'The selected default must be compatible with MaterialAsset.',
        detail: { materialGuid: input.materialGuid },
        retryable: false,
        recoveryActions: ['assets.catalog.refresh'],
      });
    }
  }

  const override = patchMeshMaterialSlotDefault(
    { ...current },
    { slotName: input.slotName, ...(input.slotSourceKey === undefined ? {} : { sourceKey: input.slotSourceKey }) },
    input.materialGuid,
  );
  const currentSlots = slotsOf(current);
  const currentDefaults = current.materialSlotDefaultOverrides;
  const nextDefaults = override.materialSlotDefaultOverrides;
  const state = {
    sourceKey,
    materialSlots: currentSlots,
    ...(currentDefaults !== undefined ? { materialSlotDefaultOverrides: currentDefaults } : {}),
  };
  const patch = {
    materialSlots: slotsOf(override),
    ...(nextDefaults === undefined ? { materialSlotDefaultOverrides: null } : { materialSlotDefaultOverrides: nextDefaults }),
  };
  const gateway = createProjectAuthoringGatewayProjection(transport);
  const result = await gateway.begin(
    { kind: 'mesh', guid: input.meshGuid },
    patch,
    { subject: { kind: 'mesh', guid: input.meshGuid }, revision: source.revision, state },
  ).commit();
  if (result !== null && typeof result === 'object' && 'ok' in result && (result as { readonly ok?: unknown }).ok === false) {
    throw fromFailure((result as { readonly error?: unknown }).error, {
      code: 'mesh-authoring-failed',
      expected: 'the Project Mesh authoring operation to commit',
      hint: 'Mesh authoring failed.',
    });
  }

  // The ToolClient is the only source writer. This existing Runtime operation
  // is only a read/recook publication seam so the disposable catalog/preview
  // can observe the new Project source without introducing a second writer.
  let refreshError: string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const refreshed = await readSourceSnapshot(transport, input.meshGuid);
    if (refreshed.sourceKey !== sourceKey) {
      refreshError = 'Project authoring snapshot identity changed while refreshing the Mesh.';
      break;
    }
    const observed = await dispatchAndWaitActiveEditorOperation({
      kind: 'reimportAsset',
      guid: input.meshGuid,
      scope: { sourceKey },
      expectedRevision: refreshed.revision,
      requestId: `toolclient-mesh-refresh-${crypto.randomUUID()}`,
    }, 'ai');
    if (observed.ok) {
      refreshError = undefined;
      break;
    }
    refreshError = observed.error.hint;
    await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
  }
  if (refreshError !== undefined) {
    throw new MeshAuthoringError({
      code: 'mesh-runtime-refresh-failed',
      expected: 'the active Editor Mesh projection to refresh after authoring',
      hint: refreshError,
      detail: { meshGuid: input.meshGuid, sourceKey },
      retryable: true,
      recoveryActions: ['assets.catalog.refresh', 'authoring.snapshot.read'],
    });
  }
  broadcastAssetsChanged('pack-changed', 'local-op', { kind: 'changed', guid: input.meshGuid });
}
