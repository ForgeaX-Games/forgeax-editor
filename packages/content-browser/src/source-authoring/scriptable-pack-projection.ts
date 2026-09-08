import type {
  ScriptablePackOutputReadModel,
  ScriptablePackReadModel,
} from '@forgeax/editor-core';

export interface ScriptablePackBrowserOutput {
  readonly guid: string;
  readonly sourceKey: string;
  readonly kind: string;
  readonly label: string;
  readonly packageUrl: string;
  readonly digest: string;
  readonly refs: readonly string[];
  readonly capabilities: ScriptablePackOutputReadModel['capabilities'];
}

export interface ScriptablePackBrowserTree {
  /** The exact canonical snapshot shared with Inspector and AI consumers. */
  readonly snapshot: ScriptablePackReadModel;
  readonly source: ScriptablePackReadModel['source'];
  readonly outputs: readonly ScriptablePackBrowserOutput[];
  readonly status: ScriptablePackReadModel['status'];
  readonly generation: number;
  readonly digest: string;
  readonly lastKnownGood: ScriptablePackReadModel['lastKnownGood'];
  readonly diagnostics: ScriptablePackReadModel['diagnostics'];
}

function outputLabel(output: ScriptablePackOutputReadModel): string {
  return `${output.kind} - ${output.sourceKey}`;
}

/** Project source and ordinary outputs without rescanning source or Catalog. */
export function projectScriptablePackBrowserTree(
  snapshot: ScriptablePackReadModel,
): ScriptablePackBrowserTree {
  return Object.freeze({
    snapshot,
    source: snapshot.source,
    outputs: Object.freeze(snapshot.outputs.map((output) => Object.freeze({
      guid: output.guid,
      sourceKey: output.sourceKey,
      kind: output.kind,
      label: outputLabel(output),
      packageUrl: output.packageUrl,
      digest: output.digest,
      refs: output.refs,
      capabilities: output.capabilities,
    }))),
    status: snapshot.status,
    generation: snapshot.generation,
    digest: snapshot.digest,
    lastKnownGood: snapshot.lastKnownGood,
    diagnostics: snapshot.diagnostics,
  });
}
