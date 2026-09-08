import type { AssetPublicationEnvelope, CatalogEntry } from '@forgeax/engine-types';
import { describe, expect, it } from 'bun:test';
import { projectScriptablePackReadModel } from '@forgeax/editor-core';
import { projectScriptablePackBrowserTree } from '../source-authoring/scriptable-pack-projection';

const SOURCE_PATH = 'assets/sample.pack.ts';
const OUTPUTS = [
  { guid: '01890000-0000-7000-8000-000000000002', sourceKey: 'scene/main', kind: 'scene', digest: 'sha256:scene', refs: [] },
  { guid: '01890000-0000-7000-8000-000000000001', sourceKey: 'mesh/main', kind: 'mesh', digest: 'sha256:mesh', refs: [] },
] as const;

function fixture(): { publication: AssetPublicationEnvelope; catalogEntries: CatalogEntry[] } {
  const publication: AssetPublicationEnvelope = {
    schemaVersion: 'asset-publication/1',
    sourcePath: SOURCE_PATH,
    sourceRevision: 'sha256:source',
    generation: 4,
    digest: 'sha256:publication',
    outputSetDigest: 'sha256:output-set',
    outputs: OUTPUTS,
    receipt: {
      schemaVersion: 'asset-publication-receipt/1',
      sourcePath: SOURCE_PATH,
      sourceRevision: 'sha256:source',
      inputFingerprint: 'sha256:input',
      outputDigest: 'sha256:publication',
      outputSetDigest: 'sha256:output-set',
      externalEvidence: [],
    },
    externalEvidence: [],
  };
  return {
    publication,
    catalogEntries: OUTPUTS.map((output) => ({
      guid: output.guid,
      kind: output.kind,
      packageUrl: `assets/${output.guid}.pack.json`,
      sourcePath: SOURCE_PATH,
      sourceKey: output.sourceKey,
      publication,
    })),
  };
}

describe('ScriptablePack Content Browser projection', () => {
  it('projects an unpublished source-only pack without fabricating output children', () => {
    const model = projectScriptablePackReadModel({ sourcePath: 'assets/unpublished.pack.ts', catalogEntries: [] });
    const tree = projectScriptablePackBrowserTree(model);

    expect(tree.status).toBe('unpublished');
    expect(tree.source.path).toBe('assets/unpublished.pack.ts');
    expect(tree.outputs).toEqual([]);
    expect(tree.snapshot).toBe(model);
  });

  it('keeps source parent identity and projects every ordinary output', () => {
    const input = fixture();
    const model = projectScriptablePackReadModel({ ...input, sourcePath: SOURCE_PATH });
    const tree = projectScriptablePackBrowserTree(model);

    expect(tree.snapshot).toBe(model);
    expect(tree.source).toMatchObject({ path: SOURCE_PATH, kind: 'asset-pack' });
    expect(tree.outputs.map((output) => [output.guid, output.kind])).toEqual([
      ['01890000-0000-7000-8000-000000000001', 'mesh'],
      ['01890000-0000-7000-8000-000000000002', 'scene'],
    ]);
    expect(tree.status).toBe(model.status);
    expect(tree.generation).toBe(model.generation);
  });

  it('retains failure and LKG state without fabricating output children', () => {
    const input = fixture();
    const failed: AssetPublicationEnvelope = {
      ...input.publication,
      failureStage: 'catalog',
      failure: {
        code: 'asset-publication-catalog-incomplete',
        stage: 'catalog',
        sourcePath: SOURCE_PATH,
        generation: 4,
        reason: 'missing output',
      },
      lastKnownGood: {
        generation: 3,
        digest: 'sha256:old',
        outputSetDigest: 'sha256:old-set',
        packageUrl: 'assets/old.pack.json',
        receiptKey: 'assets/old.receipt.json',
      },
    };
    const model = projectScriptablePackReadModel({
      sourcePath: SOURCE_PATH,
      publication: failed,
      catalogEntries: [],
    });
    const tree = projectScriptablePackBrowserTree(model);

    expect(tree.snapshot).toBe(model);
    expect(tree.outputs).toEqual([]);
    expect(tree.lastKnownGood).toMatchObject({ generation: 3 });
    expect(tree.diagnostics).toHaveLength(1);
  });
});
