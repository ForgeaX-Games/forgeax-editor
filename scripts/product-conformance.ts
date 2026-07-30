// Wave 1 composition gate.
//
// This runner validates immutable input and public adapter evidence. It never
// parses private producer modules, guesses paths, or treats local producer
// tests as product availability.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAdapter } from '../src/compatibility-adapter';
import {
  blockingAvailability,
  createEditorProduct,
  runAssetConformance,
  type ProductAvailability,
} from '@forgeax/editor-product';
import { createAssetWorkspace } from '@forgeax/editor-product';

const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const WAVE1_PRODUCER_IDS = ['engine', 'platform-io', 'harness'] as const;
export type Wave1ProducerId = (typeof WAVE1_PRODUCER_IDS)[number];

export interface Wave1ProducerInput {
  readonly mergedCommit: string;
  readonly version: string;
  readonly schemaPath: string;
  readonly fixturePath: string;
  readonly command: string;
}

export interface Wave1InputManifest {
  readonly manifestVersion: 'wave1-input/v1';
  readonly contractRevision: string;
  readonly producers: Readonly<Record<Wave1ProducerId, Wave1ProducerInput>>;
}

export interface Wave1ProducerEvidence {
  readonly observedCommit: string;
  readonly observedVersion: string;
  readonly schemaPath: string;
  readonly fixturePath: string;
  readonly isAncestor: boolean;
  readonly schemaAvailable: boolean;
  readonly fixtureAvailable: boolean;
}

export interface Wave1CompatibilityEvidence {
  readonly producers: Partial<Record<Wave1ProducerId, Wave1ProducerEvidence>>;
}

export type Wave1CompatibilityResult =
  | { readonly ok: true; readonly blocking: false; readonly code: 'wave1-compatible' }
  | {
      readonly ok: false;
      readonly blocking: true;
      readonly code: 'wave1-input-blocked';
      readonly issues: readonly string[];
      readonly hint: string;
    };

export interface Wave1PublicAdapter {
  readonly adapterId: string;
  readonly source: 'public' | 'private';
  readonly manifest: Wave1InputManifest;
  readonly usesFallbackParser?: boolean;
  readCompatibilityEvidence(): Wave1CompatibilityEvidence | Promise<Wave1CompatibilityEvidence>;
}

export type PublicAdapterResult =
  | {
      readonly ok: true;
      readonly blocking: false;
      readonly source: 'public';
      readonly adapterId: string;
      readonly evidence: Wave1CompatibilityEvidence;
    }
  | {
      readonly ok: false;
      readonly blocking: true;
      readonly code: 'adapter-manifest-mismatch' | 'adapter-boundary-blocked' | 'wave1-input-blocked';
      readonly issues: readonly string[];
      readonly hint: string;
      readonly evidence?: Wave1CompatibilityEvidence;
    };

const VALID_COMMIT = '0123456789abcdef0123456789abcdef01234567';

function freezeManifest(manifest: Wave1InputManifest): Wave1InputManifest {
  for (const producer of WAVE1_PRODUCER_IDS) {
    Object.freeze(manifest.producers[producer]);
  }
  Object.freeze(manifest.producers);
  return Object.freeze(manifest);
}

export function createValidWave1Manifest(
  overrides: { readonly contractRevision?: string } = {},
): Wave1InputManifest {
  return freezeManifest({
    manifestVersion: 'wave1-input/v1',
    contractRevision: overrides.contractRevision ?? 'wave1-contract-revision',
    producers: {
      engine: {
        mergedCommit: VALID_COMMIT,
        version: 'engine-contract/1',
        schemaPath: 'engine/schema.json',
        fixturePath: 'engine/fixture.json',
        command: 'bun run producer:engine-compatibility',
      },
      'platform-io': {
        mergedCommit: VALID_COMMIT,
        version: 'platform-io-contract/1',
        schemaPath: 'platform-io/schema.json',
        fixturePath: 'platform-io/fixture.json',
        command: 'bun run producer:platform-io-compatibility',
      },
      harness: {
        mergedCommit: VALID_COMMIT,
        version: 'harness-contract/1',
        schemaPath: 'harness/schema.json',
        fixturePath: 'harness/fixture.json',
        command: 'bun run producer:harness-compatibility',
      },
    },
  });
}

export function createValidWave1Evidence(
  manifest: Wave1InputManifest,
): Wave1CompatibilityEvidence {
  const evidenceFor = (producer: Wave1ProducerId): Wave1ProducerEvidence => {
    const input = manifest.producers[producer];
    return {
      observedCommit: input.mergedCommit,
      observedVersion: input.version,
      schemaPath: input.schemaPath,
      fixturePath: input.fixturePath,
      isAncestor: true,
      schemaAvailable: true,
      fixtureAvailable: true,
    };
  };
  return {
    producers: Object.fromEntries(
      WAVE1_PRODUCER_IDS.map((producer) => [producer, evidenceFor(producer)]),
    ) as Record<Wave1ProducerId, Wave1ProducerEvidence>,
  };
}

export function checkWave1Compatibility(
  manifest: Wave1InputManifest,
  evidence: Wave1CompatibilityEvidence,
): Wave1CompatibilityResult {
  const issues: string[] = [];
  for (const producer of WAVE1_PRODUCER_IDS) {
    const input = manifest.producers[producer];
    const observed = evidence.producers[producer];
    if (!input || !observed) {
      issues.push(`missing-producer:${producer}`);
      continue;
    }
    if (observed.observedCommit !== input.mergedCommit) issues.push(`commit-mismatch:${producer}`);
    if (observed.observedVersion !== input.version) issues.push(`version-mismatch:${producer}`);
    if (observed.schemaPath !== input.schemaPath) issues.push(`schema-path-mismatch:${producer}`);
    if (observed.fixturePath !== input.fixturePath) issues.push(`fixture-path-mismatch:${producer}`);
    if (!observed.isAncestor) issues.push(`ancestor-mismatch:${producer}`);
    if (!observed.schemaAvailable) issues.push(`missing-schema:${producer}`);
    if (!observed.fixtureAvailable) issues.push(`missing-fixture:${producer}`);
  }
  if (issues.length > 0) {
    return {
      ok: false,
      blocking: true,
      code: 'wave1-input-blocked',
      issues,
      hint: 'Do not freeze producer-dependent Editor details until the immutable Wave 1 composition evidence is complete.',
    };
  }
  return { ok: true, blocking: false, code: 'wave1-compatible' };
}

function sameManifest(left: Wave1InputManifest, right: Wave1InputManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createPublicAdapterFixture(
  manifest: Wave1InputManifest,
  options: {
    readonly source?: 'public' | 'private';
    readonly usesFallbackParser?: boolean;
  } = {},
): Wave1PublicAdapter {
  return {
    adapterId: 'wave1-public-adapter-fixture',
    source: options.source ?? 'public',
    manifest,
    usesFallbackParser: options.usesFallbackParser ?? false,
    readCompatibilityEvidence: () => createValidWave1Evidence(manifest),
  };
}

export async function runPublicAdapter(
  adapter: Wave1PublicAdapter,
  manifest: Wave1InputManifest,
): Promise<PublicAdapterResult> {
  if (!sameManifest(adapter.manifest, manifest)) {
    return {
      ok: false,
      blocking: true,
      code: 'adapter-manifest-mismatch',
      issues: ['adapter-manifest-mismatch'],
      hint: 'The adapter must consume the immutable manifest selected by the composition gate.',
    };
  }
  if (adapter.source !== 'public' || adapter.usesFallbackParser === true) {
    return {
      ok: false,
      blocking: true,
      code: 'adapter-boundary-blocked',
      issues: ['private-or-fallback-adapter'],
      hint: 'Only a public adapter may provide producer evidence; private parsers are not a compatibility result.',
    };
  }
  const evidence = await adapter.readCompatibilityEvidence();
  const compatibility = checkWave1Compatibility(manifest, evidence);
  if (!compatibility.ok) return { ...compatibility, evidence };
  return {
    ok: true,
    blocking: false,
    source: adapter.source,
    adapterId: adapter.adapterId,
    evidence,
  };
}

export interface ProductConformanceReport {
  readonly status: 'blocked' | 'compatible';
  readonly availability: ProductAvailability;
  readonly issues: readonly string[];
}

export const STANDALONE_SMOKE_STEPS = [
  'boot',
  'open',
  'catalog',
  'save',
  'play',
  'stop',
] as const;

type StandaloneSmokeStep = (typeof STANDALONE_SMOKE_STEPS)[number];
type StandalonePublicAdapter = ReturnType<typeof createAdapter>;

/** Return the repository's published adapter without substituting a test double. */
export function createDefaultConformanceAdapter(): StandalonePublicAdapter {
  return createAdapter();
}

function validRevision(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function gitRevision(cwd: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function gitCommitExists(revision: string): boolean {
  const result = spawnSync('git', ['cat-file', '-e', `${revision}^{commit}`], {
    cwd: editorRoot,
    encoding: 'utf8',
  });
  return result.status === 0;
}

function gitIsAncestor(ancestor: string, descendant: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: editorRoot,
    encoding: 'utf8',
  });
  return result.status === 0;
}

function validateStandaloneAdapter(adapter: StandalonePublicAdapter): string[] {
  const issues: string[] = [];
  const currentProductRevision = gitRevision(editorRoot);
  const currentContractRevision = gitRevision(process.cwd());
  if (adapter.manifest.manifestVersion !== '1.0.0') {
    issues.push('adapter-manifest-version-mismatch');
  }
  if (adapter.manifest.adapterId !== 'standalone-editor-public-adapter') {
    issues.push('adapter-id-mismatch');
  }
  if (adapter.manifest.entrypoint !== '@forgeax/editor/compatibility-adapter') {
    issues.push('adapter-entrypoint-mismatch');
  }
  if (adapter.pin.product !== 'standalone-editor') {
    issues.push('adapter-product-mismatch');
  }
  if (!validRevision(adapter.pin.productRevision)) {
    issues.push('adapter-product-revision-invalid');
  }
  if (!validRevision(adapter.pin.contractRevision)) {
    issues.push('adapter-contract-revision-invalid');
  }
  if (!validRevision(adapter.pin.adapterRevision)) {
    issues.push('adapter-revision-invalid');
  }
  if (currentProductRevision === undefined || adapter.pin.productRevision !== currentProductRevision) {
    issues.push('adapter-product-revision-mismatch');
  }
  if (currentContractRevision === undefined || adapter.pin.contractRevision !== currentContractRevision) {
    issues.push('adapter-contract-revision-mismatch');
  }
  if (currentProductRevision === undefined || adapter.pin.adapterRevision !== currentProductRevision) {
    issues.push('adapter-revision-source-mismatch');
  }
  if (adapter.pin.adapterRevision !== adapter.pin.productRevision) {
    issues.push('adapter-revision-product-mismatch');
  }
  const immutable =
    validRevision(adapter.pin.productRevision) &&
    validRevision(adapter.pin.contractRevision) &&
    validRevision(adapter.pin.adapterRevision) &&
    gitCommitExists(adapter.pin.productRevision) &&
    gitCommitExists(adapter.pin.contractRevision) &&
    gitCommitExists(adapter.pin.adapterRevision);
  if (!immutable || !adapter.pin.revisionEvidence.immutable) {
    issues.push('adapter-revision-not-immutable');
  }
  const isAncestor =
    immutable &&
    gitIsAncestor(adapter.pin.adapterRevision, adapter.pin.contractRevision);
  if (adapter.pin.revisionEvidence.isAncestor !== isAncestor) {
    issues.push('adapter-revision-ancestry-unverified');
  }
  if (!isAncestor) {
    issues.push('adapter-revision-not-ancestor');
  }
  if (JSON.stringify(adapter.pin.publicManifest) !== JSON.stringify(adapter.manifest)) {
    issues.push('adapter-public-manifest-mismatch');
  }
  if (typeof adapter.smoke !== 'function') {
    issues.push('adapter-smoke-missing');
  }
  return issues;
}

/** Run the real standalone adapter's complete public compatibility smoke. */
export function runStandalonePublicAdapter(
  adapter: StandalonePublicAdapter = createDefaultConformanceAdapter(),
): ProductAvailability {
  const issues = validateStandaloneAdapter(adapter);
  if (issues.length > 0) return blockingAvailability(issues);

  for (const step of STANDALONE_SMOKE_STEPS) {
    let observation: ReturnType<StandalonePublicAdapter['smoke']>;
    try {
      observation = adapter.smoke(step as StandaloneSmokeStep);
    } catch {
      issues.push(`smoke-error:${step}`);
      continue;
    }
    if (observation.outcome !== 'passed') {
      issues.push(`smoke-${observation.outcome}:${step}`);
    }
  }
  return issues.length > 0
    ? blockingAvailability(issues)
    : { available: true, blocking: false, code: 'product-available' };
}

export function runProductHeadless(): { readonly ok: true; readonly contractVersion: string } {
  const product = createEditorProduct();
  const discovered = product.discover();
  if (discovered.manifest.productId !== '@forgeax/editor-product') {
    throw new Error('product manifest identity mismatch');
  }
  return { ok: true, contractVersion: product.contractVersion };
}

export function runProductWorkspaceHeadless() {
  const workspace = createAssetWorkspace();
  const input = {
    resourceRevision: 'resource:r1',
    logicalCommitId: 'commit:headless',
    subjects: [{
      id: 'subject:headless' as never,
      kind: 'external-package' as const,
      provenance: { owner: 'platform-io' as const, source: 'observer', packageId: 'package:headless' },
      resourceId: 'resource:headless',
      path: 'assets/headless.pack.json',
      capabilities: { canImport: false, canMove: true, canDelete: true, canPreflight: true },
    }],
    relations: [],
    issues: [],
  };
  const result = workspace.reconcile(input);
  const repeated = workspace.reconcile(input);
  return {
    ok: true as const,
    revision: result.snapshot.revision,
    snapshot: result.snapshot,
    repeatedSnapshot: repeated.snapshot,
  };
}

export function runProductConformance(): ProductConformanceReport {
  const availability = process.env.FORGEAX_WAVE1_MANIFEST
    ? loadManifestAvailability(process.env.FORGEAX_WAVE1_MANIFEST)
    : runStandalonePublicAdapter();
  return {
    status: availability.available ? 'compatible' : 'blocked',
    availability,
    issues: availability.available ? [] : availability.issues,
  };
}

export async function runProductAssetConformance() {
  return runAssetConformance();
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateWave1ManifestDocument(value: unknown): string[] {
  const document = asRecord(value);
  if (!document) return ['manifest-not-an-object'];

  const issues: string[] = [];
  if (document.manifestVersion !== 'wave1-input/v1') {
    issues.push('manifest-version-mismatch');
  }
  if (!validRevision(String(document.contractRevision ?? ''))) {
    issues.push('manifest-contract-revision-invalid');
  }

  const producers = asRecord(document.producers);
  if (!producers) return [...issues, 'manifest-producers-invalid'];

  const producerKeys = Object.keys(producers);
  for (const producer of WAVE1_PRODUCER_IDS) {
    if (!(producer in producers)) {
      issues.push(`manifest-missing-producer:${producer}`);
    }
  }
  for (const producer of producerKeys) {
    if (!(WAVE1_PRODUCER_IDS as readonly string[]).includes(producer)) {
      issues.push(`manifest-unexpected-producer:${producer}`);
    }
  }

  for (const producer of WAVE1_PRODUCER_IDS) {
    const input = asRecord(producers[producer]);
    if (!input) {
      if (producer in producers) issues.push(`manifest-producer-invalid:${producer}`);
      continue;
    }
    if (!validRevision(String(input.mergedCommit ?? ''))) {
      issues.push(`manifest-merged-commit-invalid:${producer}`);
    }
    for (const field of ['version', 'schemaPath', 'fixturePath', 'command'] as const) {
      if (!nonEmptyString(input[field])) {
        issues.push(`manifest-empty-${field}:${producer}`);
      }
    }
  }
  return issues;
}

function isCompatibleAvailability(value: unknown): boolean {
  const availability = asRecord(value);
  const keys = availability === undefined ? [] : Object.keys(availability).sort();
  return (
    JSON.stringify(keys) === JSON.stringify(['available', 'blocking', 'code']) &&
    availability?.available === true &&
    availability.blocking === false &&
    availability.code === 'product-available'
  );
}

export function loadManifestAvailability(path: string): ProductAvailability {
  const manifestPath = resolve(process.cwd(), path);
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    const issues = validateWave1ManifestDocument(parsed);
    if (issues.length > 0) return blockingAvailability(issues);
    if (isCompatibleAvailability(asRecord(parsed)?.availability)) {
      return { available: true, blocking: false, code: 'product-available' };
    }
    return blockingAvailability(['manifest-availability-not-compatible']);
  } catch {
    return blockingAvailability(['manifest-unreadable']);
  }
}

if (import.meta.main) {
  const output = process.argv.includes('--headless')
    ? runProductHeadless()
    : { ...runProductConformance(), assetConformance: await runProductAssetConformance() };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if ('assetConformance' in output && output.assetConformance.failed > 0) process.exitCode = 1;
}
