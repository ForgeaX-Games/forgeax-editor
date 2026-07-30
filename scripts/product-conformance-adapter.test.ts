import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { createAdapter } from '../src/compatibility-adapter';
import {
  createDefaultConformanceAdapter,
  createPublicAdapterFixture,
  createValidWave1Evidence,
  createValidWave1Manifest,
  loadManifestAvailability,
  runPublicAdapter,
  runStandalonePublicAdapter,
} from './product-conformance';

const VALID_REVISION = 'a'.repeat(40);

function createManifestDocument() {
  const manifest = createValidWave1Manifest({
    contractRevision: VALID_REVISION,
  });
  return {
    ...manifest,
    availability: {
      available: true,
      blocking: false,
      code: 'product-available',
    },
  };
}

function withManifestFile<T>(document: unknown, callback: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-wave1-'));
  const path = join(directory, 'manifest.json');
  writeFileSync(path, JSON.stringify(document));
  try {
    return callback(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('standalone conformance adapter wiring', () => {
  test('default factory exposes the real public adapter contract', () => {
    const actual = createAdapter();
    const selected = createDefaultConformanceAdapter();

    expect(selected.manifest).toEqual(actual.manifest);
    expect(selected.pin).toEqual(actual.pin);
    expect(selected.smoke).toBeFunction();
    expect(selected.pin.revisionEvidence).toEqual({ immutable: true, isAncestor: true });
  });

  test('blocks a revision that is not an ancestor even when its metadata claims it is', () => {
    const actual = createAdapter();
    const adapter = {
      ...actual,
      pin: {
        ...actual.pin,
        adapterRevision: '0'.repeat(40),
        revisionEvidence: { immutable: true, isAncestor: true },
      },
    };

    expect(runStandalonePublicAdapter(adapter)).toMatchObject({
      available: false,
      blocking: true,
    });
    expect(runStandalonePublicAdapter(adapter).issues).toContain('adapter-revision-not-ancestor');
  });

  test('blocks malformed revisions instead of trusting ancestry metadata', () => {
    const actual = createAdapter();
    const adapter = {
      ...actual,
      pin: {
        ...actual.pin,
        productRevision: 'bad-revision',
        contractRevision: 'bad-revision',
        adapterRevision: 'bad-revision',
        revisionEvidence: { immutable: true, isAncestor: true },
      },
    };

    const result = runStandalonePublicAdapter(adapter);

    expect(result).toMatchObject({ available: false, blocking: true });
    expect(result.issues).toEqual(expect.arrayContaining([
      'adapter-product-revision-invalid',
      'adapter-contract-revision-invalid',
      'adapter-revision-invalid',
      'adapter-revision-not-immutable',
      'adapter-revision-not-ancestor',
    ]));
  });

  test('blocks a smoke failure instead of publishing product availability', () => {
    const actual = createAdapter();
    const adapter = {
      ...actual,
      smoke: (step: Parameters<typeof actual.smoke>[0]) => ({
        step,
        outcome: step === 'play' ? ('failed' as const) : ('passed' as const),
        evidence: 'synthetic failure evidence',
      }),
    };

    const result = runStandalonePublicAdapter(adapter);

    expect(result).toMatchObject({
      available: false,
      blocking: true,
    });
    expect(result.issues).toContain('smoke-failed:play');
  });
});

describe('explicit Wave 1 manifest validation', () => {
  test('accepts the complete wave1-input/v1 manifest only with compatible availability', () => {
    const result = withManifestFile(createManifestDocument(), loadManifestAvailability);

    expect(result).toEqual({
      available: true,
      blocking: false,
      code: 'product-available',
    });
  });

  test('blocks an invalid revision before trusting availability', () => {
    const document = createManifestDocument();
    const result = withManifestFile({ ...document, contractRevision: 'wrong' }, loadManifestAvailability);

    expect(result.available).toBe(false);
    expect(result.issues).toContain('manifest-contract-revision-invalid');
  });

  test('blocks a manifest with a missing producer', () => {
    const document = createManifestDocument();
    const producers = { ...document.producers } as Record<string, unknown>;
    delete producers.engine;
    const result = withManifestFile({ ...document, producers }, loadManifestAvailability);

    expect(result.available).toBe(false);
    expect(result.issues).toContain('manifest-missing-producer:engine');
  });

  test('blocks malformed producer input instead of inferring missing fields', () => {
    const document = createManifestDocument();
    const producers = {
      ...document.producers,
      engine: null,
    };
    const result = withManifestFile({ ...document, producers }, loadManifestAvailability);

    expect(result.available).toBe(false);
    expect(result.issues).toContain('manifest-producer-invalid:engine');
  });

  test('blocks a malformed manifest document', () => {
    const result = withManifestFile([], loadManifestAvailability);

    expect(result).toMatchObject({ available: false, blocking: true });
    expect(result.issues).toContain('manifest-not-an-object');
  });

  test('blocks empty producer contract fields instead of inferring them', () => {
    const document = createManifestDocument();
    const producers = {
      ...document.producers,
      engine: {
        ...document.producers.engine,
        version: ' ',
        schemaPath: '',
        fixturePath: '  ',
        command: '',
      },
    };
    const result = withManifestFile({ ...document, producers }, loadManifestAvailability);

    expect(result.available).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      'manifest-empty-version:engine',
      'manifest-empty-schemaPath:engine',
      'manifest-empty-fixturePath:engine',
      'manifest-empty-command:engine',
    ]));
  });

  test('blocks forged availability and does not return its payload', () => {
    const document = createManifestDocument();
    const result = withManifestFile({
      ...document,
      availability: { available: true, blocking: true, code: 'product-available' },
    }, loadManifestAvailability);

    expect(result).toMatchObject({
      available: false,
      blocking: true,
    });
    expect(result.issues).toContain('manifest-availability-not-compatible');
  });

  test('blocks availability with an extra forged payload field', () => {
    const document = createManifestDocument();
    const result = withManifestFile({
      ...document,
      availability: {
        available: true,
        blocking: false,
        code: 'product-available',
        evidence: 'forged',
      },
    }, loadManifestAvailability);

    expect(result).toMatchObject({ available: false, blocking: true });
    expect(result.issues).toContain('manifest-availability-not-compatible');
  });
});

describe('Wave 1 public adapter boundary', () => {
  test('consumes the manifest-selected public adapter evidence', async () => {
    const manifest = createValidWave1Manifest();
    const adapter = createPublicAdapterFixture(manifest);

    const result = await runPublicAdapter(adapter, manifest);

    expect(result).toMatchObject({
      ok: true,
      source: 'public',
      adapterId: 'wave1-public-adapter-fixture',
    });
    expect(result.evidence).toEqual(createValidWave1Evidence(manifest));
  });

  test('rejects an adapter bound to a different manifest revision', async () => {
    const manifest = createValidWave1Manifest();
    const adapter = createPublicAdapterFixture(createValidWave1Manifest({
      contractRevision: 'different-contract-revision',
    }));

    const result = await runPublicAdapter(adapter, manifest);

    expect(result).toMatchObject({
      ok: false,
      blocking: true,
      code: 'adapter-manifest-mismatch',
    });
  });

  test('rejects private or fallback producer implementations', async () => {
    const manifest = createValidWave1Manifest();
    const privateAdapter = createPublicAdapterFixture(manifest, {
      source: 'private',
    });
    const fallbackAdapter = createPublicAdapterFixture(manifest, {
      usesFallbackParser: true,
    });

    await expect(runPublicAdapter(privateAdapter, manifest)).resolves.toMatchObject({
      ok: false,
      blocking: true,
      code: 'adapter-boundary-blocked',
    });
    await expect(runPublicAdapter(fallbackAdapter, manifest)).resolves.toMatchObject({
      ok: false,
      blocking: true,
      code: 'adapter-boundary-blocked',
    });
  });
});
