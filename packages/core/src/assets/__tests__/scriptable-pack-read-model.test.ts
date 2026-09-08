import type { AssetPublicationEnvelope, AssetPublicationOutput, CatalogEntry } from '@forgeax/engine-types';
import { describe, expect, it } from 'bun:test';
import { projectScriptablePackReadModel } from '../scriptable-pack-read-model';

const SOURCE_PATH = 'assets/generated.pack.ts';

function publication(): AssetPublicationEnvelope {
  const outputs: AssetPublicationOutput[] = [
    {
      guid: '01890000-0000-7000-8000-000000000003',
      sourceKey: 'scene/main',
      kind: 'scene',
      digest: 'sha256:scene',
      refs: ['01890000-0000-7000-8000-000000000001'],
    },
    {
      guid: '01890000-0000-7000-8000-000000000001',
      sourceKey: 'mesh/main',
      kind: 'mesh',
      digest: 'sha256:mesh',
      refs: [],
    },
    {
      guid: '01890000-0000-7000-8000-000000000002',
      sourceKey: 'material/main',
      kind: 'material',
      digest: 'sha256:material',
      refs: [],
    },
  ];
  return {
    schemaVersion: 'asset-publication/1',
    sourcePath: SOURCE_PATH,
    sourceRevision: 'sha256:source',
    generation: 7,
    digest: 'sha256:publication',
    outputSetDigest: 'sha256:output-set',
    outputs,
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
}

function catalogEntries(envelope: AssetPublicationEnvelope): CatalogEntry[] {
  return envelope.outputs.map((output) => ({
    guid: output.guid,
    kind: output.kind,
    packageUrl: `assets/${output.guid}.pack.json`,
    sourcePath: envelope.sourcePath,
    sourceKey: output.sourceKey,
    publication: envelope,
  }));
}

function dependencyEntry(guid: string, generation: number, digest: string): CatalogEntry {
  const dependencyPublication: AssetPublicationEnvelope = {
    ...publication(),
    sourcePath: `assets/${guid}.pack.ts`,
    sourceRevision: `sha256:dependency-source-${guid}`,
    generation,
    digest: `sha256:dependency-publication-${guid}`,
    outputSetDigest: `sha256:dependency-output-set-${guid}`,
    outputs: [{ guid, sourceKey: 'mesh/main', kind: 'mesh', digest, refs: [] }],
    receipt: {
      ...publication().receipt,
      sourcePath: `assets/${guid}.pack.ts`,
      sourceRevision: `sha256:dependency-source-${guid}`,
      outputDigest: `sha256:dependency-publication-${guid}`,
      outputSetDigest: `sha256:dependency-output-set-${guid}`,
    },
  };
  return {
    guid,
    kind: 'mesh',
    packageUrl: `assets/${guid}.pack.json`,
    sourcePath: dependencyPublication.sourcePath,
    sourceKey: 'mesh/main',
    publication: dependencyPublication,
  };
}

describe('ScriptablePack canonical read model', () => {
  it('keeps a source-only pack visible as an explicit unpublished empty output set', () => {
    const model = projectScriptablePackReadModel({ sourcePath: 'assets/unpublished.pack.ts', catalogEntries: [] });

    expect(model.status).toBe('unpublished');
    expect(model.source).toMatchObject({ path: 'assets/unpublished.pack.ts', outputs: [] });
    expect(model.outputs).toEqual([]);
    expect(model.publication).toBeUndefined();
    expect(model.receipt).toBeUndefined();
    expect(model.generation).toBe(0);
    expect(model.diagnostics).toEqual([]);
  });

  it('keeps the Pack source parent and projects ordinary outputs in stable order', () => {
    const publicationEnvelope = publication();
    const model = projectScriptablePackReadModel({
      sourcePath: SOURCE_PATH,
      publication: publicationEnvelope,
      catalogEntries: catalogEntries(publicationEnvelope),
    });

    expect(model.source).toMatchObject({ path: SOURCE_PATH, kind: 'asset-pack' });
    expect(model.source.outputs).toEqual([
      '01890000-0000-7000-8000-000000000001',
      '01890000-0000-7000-8000-000000000002',
      '01890000-0000-7000-8000-000000000003',
    ]);
    expect(model.outputs.map((output) => [output.sourceKey, output.guid, output.kind])).toEqual([
      ['material/main', '01890000-0000-7000-8000-000000000002', 'material'],
      ['mesh/main', '01890000-0000-7000-8000-000000000001', 'mesh'],
      ['scene/main', '01890000-0000-7000-8000-000000000003', 'scene'],
    ]);
    expect(model.outputs.every((output) => output.sourcePath === SOURCE_PATH)).toBe(true);
    expect(model.publication).toBe(publicationEnvelope);
  });

  it('does not invent output rows when the published catalog is incomplete', () => {
    const publicationEnvelope = publication();
    const model = projectScriptablePackReadModel({
      sourcePath: SOURCE_PATH,
      publication: publicationEnvelope,
      catalogEntries: catalogEntries(publicationEnvelope).slice(0, 2),
    });

    expect(model.outputs).toHaveLength(0);
    expect(model.source.outputs).toEqual([]);
    expect(model.status).toBe('failed');
    expect(model.failure?.stage).toBe('catalog');
    expect(model.lastKnownGood).toBeUndefined();
  });

  it('projects a failed publication as source diagnostics while retaining its LKG locator', () => {
    const candidate = publication();
    const failed: AssetPublicationEnvelope = {
      ...candidate,
      generation: 8,
      failureStage: 'route',
      failure: {
        code: 'asset-publication-route-failed',
        stage: 'route',
        sourcePath: SOURCE_PATH,
        generation: 8,
        reason: 'route unavailable',
      },
      current: {
        generation: 7,
        digest: candidate.digest,
        outputSetDigest: candidate.outputSetDigest,
        packageUrl: 'assets/generation-7.pack.json',
        receiptKey: 'assets/generation-7.receipt.json',
      },
      lastKnownGood: {
        generation: 7,
        digest: candidate.digest,
        outputSetDigest: candidate.outputSetDigest,
        packageUrl: 'assets/generation-7.pack.json',
        receiptKey: 'assets/generation-7.receipt.json',
      },
      recovery: {
        retryable: true,
        preserveCurrent: true,
        useLastKnownGood: true,
        actions: ['run.retry', 'catalog.reconcile'],
      },
    };
    const model = projectScriptablePackReadModel({
      sourcePath: SOURCE_PATH,
      publication: failed,
      catalogEntries: [],
    });

    expect(model.status).toBe('failed');
    expect(model.outputs).toEqual([]);
    expect(model.lastKnownGood).toMatchObject({ generation: 7 });
    expect(model.failure).toMatchObject({ code: 'asset-publication-route-failed', stage: 'route' });
  });

  it('derives dependency usage from the Engine receipt R/C evidence', () => {
    const candidate = publication();
    const evidence = [
      { guid: 'guid:reference', usage: 'reference' as const, generation: 11, digest: 'sha256:r' },
      { guid: 'guid:content', usage: 'content' as const, generation: 12, digest: 'sha256:c' },
      { guid: 'guid:both', usage: 'both' as const, generation: 13, digest: 'sha256:b' },
    ];
    const withEvidence: AssetPublicationEnvelope = {
      ...candidate,
      externalEvidence: evidence,
      receipt: { ...candidate.receipt, externalEvidence: evidence },
    };
    const model = projectScriptablePackReadModel({
      sourcePath: SOURCE_PATH,
      publication: withEvidence,
      catalogEntries: [...catalogEntries(withEvidence),
        dependencyEntry('guid:reference', 11, 'sha256:r'),
        dependencyEntry('guid:content', 12, 'sha256:c'),
        dependencyEntry('guid:both', 13, 'sha256:b'),
      ],
    });

    expect(model.externalEvidence).toEqual([
      { guid: 'guid:reference', usage: 'referenced', generation: 11, digest: 'sha256:r' },
      { guid: 'guid:content', usage: 'content-read', generation: 12, digest: 'sha256:c' },
      { guid: 'guid:both', usage: 'both', generation: 13, digest: 'sha256:b' },
    ]);
    expect(model.dependencies).toMatchObject([
      { guid: 'guid:reference', usage: 'referenced', status: 'ready', generation: 11, digest: 'sha256:r' },
      { guid: 'guid:content', usage: 'content-read', status: 'ready', generation: 12, digest: 'sha256:c' },
      { guid: 'guid:both', usage: 'both', status: 'ready', generation: 13, digest: 'sha256:b' },
    ]);
    expect(model.externalEvidence.every((entry) => entry.generation !== model.generation)).toBe(true);
    expect(model.externalEvidence.every((entry) => entry.digest?.startsWith('sha256:'))).toBe(true);
  });

  it('projects one dependency diagnostic object to both the row and model diagnostics', () => {
    const candidate = publication();
    const withMissingEvidence: AssetPublicationEnvelope = {
      ...candidate,
      externalEvidence: [{ guid: 'guid:missing', usage: 'reference', generation: candidate.generation, digest: 'sha256:missing' }],
    };
    const model = projectScriptablePackReadModel({
      sourcePath: SOURCE_PATH,
      publication: withMissingEvidence,
      catalogEntries: catalogEntries(withMissingEvidence),
    });
    const dependency = model.dependencies[0]!;
    const diagnostic = dependency.diagnostic!;

    expect(dependency).toMatchObject({ guid: 'guid:missing', status: 'missing' });
    expect(dependency.diagnostic).toMatchObject({
      code: 'asset-publication-dependency-missing',
      stage: 'receipt',
      sourcePath: SOURCE_PATH,
      outputGuid: 'guid:missing',
      reason: 'Dependency guid:missing has missing publication evidence',
      recoveryActions: ['run.retry', 'catalog.reconcile'],
    });
    expect(model.diagnostics).toEqual([diagnostic]);
    expect(model.diagnostics[0]).toBe(diagnostic);
  });

  it('marks a dependency stale only when its own publication tuple differs', () => {
    const candidate = publication();
    const dependency = { guid: 'guid:stale', usage: 'content' as const, generation: 21, digest: 'sha256:expected' };
    const withEvidence: AssetPublicationEnvelope = {
      ...candidate,
      externalEvidence: [dependency],
      receipt: { ...candidate.receipt, externalEvidence: [dependency] },
    };
    const model = projectScriptablePackReadModel({
      publication: withEvidence,
      catalogEntries: [dependencyEntry(dependency.guid, 22, 'sha256:actual')],
    });
    expect(model.dependencies[0]).toMatchObject({
      guid: dependency.guid,
      status: 'stale',
      generation: dependency.generation,
      digest: dependency.digest,
      diagnostic: { code: 'asset-publication-dependency-stale', expected: '21:sha256:expected', actual: '22:sha256:actual' },
    });
  });
});
