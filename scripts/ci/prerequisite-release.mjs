import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, relative, resolve} from 'node:path';
import process from 'node:process';

const CONTRACT_PATH = resolve('scripts/ci/editor-ci-contract.json');
const RELEASE_SCHEMA_VERSION = 'forgeax-prerequisite-release/v1';
const RELEASE_MANIFEST_NAME = 'manifest.json';
const DEFAULT_PROFILE = 'PR';
const PROFILE_ALIASES = Object.freeze({complete: 'PR'});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')}`;
}

function bytesDigest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function errorResult(code, details) {
  return {
    ok: false,
    error: {
      code,
      ...details,
      artifactId: details.artifactId ?? null,
      hint: details.hint,
    },
  };
}

function baseDetails(manifest, consumer) {
  return {
    affectedConsumer: consumer,
    artifactId: manifest?.artifactId ?? null,
  };
}

function reject(code, manifest, consumer, details) {
  return errorResult(code, {...baseDetails(manifest, consumer), ...details});
}

function readContract() {
  return JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
}

function producerError(code, details) {
  return {
    ok: false,
    error: {
      code,
      ...details,
      hint: details.hint,
    },
  };
}

function normalizeProfile(contract, profile) {
  const requested = profile ?? DEFAULT_PROFILE;
  const profileName = PROFILE_ALIASES[requested] ?? requested;
  const consumers = contract.prerequisiteRelease.activeProfiles[profileName];
  if (!Array.isArray(consumers) || consumers.length === 0) {
    return producerError(
      'profile-unknown',
      {
        failedField: 'profile',
        expected: Object.keys(contract.prerequisiteRelease.activeProfiles),
        observed: requested,
        hint: 'Use an active cloud profile declared by prerequisiteRelease.',
      },
    );
  }
  return {ok: true, profileName, consumers};
}

function payloadUnion(contract, consumers) {
  const requested = new Set();
  for (const consumer of consumers) {
    const declared = contract.prerequisiteRelease.consumers[consumer];
    if (!Array.isArray(declared)) {
      return producerError(
        'consumer-unknown',
        {
          failedField: `activeProfiles.${consumer}`,
          expected: Object.keys(contract.prerequisiteRelease.consumers),
          observed: consumer,
          hint: 'Declare every active profile consumer in prerequisiteRelease before producing a release.',
        },
      );
    }
    for (const payloadClass of declared) {
      requested.add(payloadClass);
    }
  }
  const payloadClasses = Object.keys(contract.prerequisiteRelease.payloadClasses)
    .filter((payloadClass) => requested.has(payloadClass));
  return {ok: true, payloadClasses};
}

export function deriveRecursivePins({cwd = process.cwd()} = {}) {
  try {
    const output = execFileSync('git', ['submodule', 'status', '--recursive'], {cwd, encoding: 'utf8'});
    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^[-+ ]?([0-9a-f]{40})\s+(.+?)(?:\s+\(.+\))?$/);
        return match ? {path: match[2], pin: match[1]} : null;
      })
      .filter(Boolean);
  } catch (error) {
    const failure = new Error(
      `unable to derive recursive submodule pins from ${cwd}: ${error.message ?? String(error)}`,
      {cause: error},
    );
    failure.code = 'recursive-pin-derivation-failure';
    throw failure;
  }
}

function normalizeEnvironment(input) {
  const environment = input ?? {};
  return {
    os: environment.os ?? process.env.RUNNER_OS?.toLowerCase() ?? process.platform,
    architecture: environment.architecture ?? process.env.RUNNER_ARCH?.toLowerCase() ?? process.arch,
    bunVersion: environment.bunVersion ?? process.env.CI_BUN_VERSION ?? null,
    nodeVersion: environment.nodeVersion ?? process.env.CI_NODE_VERSION ?? process.versions.node,
    pnpmVersion: environment.pnpmVersion ?? process.env.CI_PNPM_VERSION ?? null,
    rustVersion: environment.rustVersion ?? process.env.CI_RUST_TOOLCHAIN ?? null,
    wasmPackVersion: environment.wasmPackVersion ?? process.env.CI_WASM_PACK_VERSION ?? null,
    capacityPool: environment.capacityPool ?? process.env.CI_CAPACITY_POOL ?? 'standard',
  };
}

function normalizeCompatibility(environment, compatibility) {
  const source = compatibility ?? environment;
  return {
    os: source.os,
    architecture: source.architecture,
    bunVersion: source.bunVersion,
    nodeVersion: source.nodeVersion,
    pnpmVersion: source.pnpmVersion,
    rustVersion: source.rustVersion,
    wasmPackVersion: source.wasmPackVersion,
    capacityPool: Array.isArray(source.capacityPool) ? [...source.capacityPool] : [source.capacityPool],
  };
}

function listFiles(root) {
  if (!existsSync(root)) throw new Error(`materialization source is missing: ${root}`);
  const files = {};
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name);
      const info = statSync(path);
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) files[relative(root, path)] = readFileSync(path);
    }
  };
  visit(root);
  if (Object.keys(files).length === 0) throw new Error(`materialization source is empty: ${root}`);
  return files;
}

function defaultMaterialize({payloadClass, environment}) {
  if (payloadClass === 'bun-install-facts') {
    return {
      'install.json': JSON.stringify({
        bunVersion: environment.bunVersion,
        nodeVersion: environment.nodeVersion,
        pnpmVersion: environment.pnpmVersion,
      }),
    };
  }
  const sources = {
    'engine-dist': resolve('packages/engine/packages'),
    'wgpu-wasm': resolve('packages/engine/packages/wgpu-wasm/pkg'),
    'fbx-wasm': resolve('packages/engine/packages/fbx/pkg'),
  };
  if (!sources[payloadClass]) {
    throw new Error(`no materializer is registered for payload class ${payloadClass}`);
  }
  if (payloadClass === 'engine-dist') {
    const files = {};
    for (const packageName of readdirSync(sources[payloadClass]).sort()) {
      const dist = resolve(sources[payloadClass], packageName, 'dist');
      if (existsSync(dist) && statSync(dist).isDirectory()) {
        for (const [path, value] of Object.entries(listFiles(dist))) files[`${packageName}/dist/${path}`] = value;
      }
    }
    if (Object.keys(files).length === 0) throw new Error('engine-dist materialization source is empty');
    return files;
  }
  return listFiles(sources[payloadClass]);
}

function safeRelativePath(path) {
  const normalized = String(path).replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return null;
  return normalized;
}

function asFileMap(value) {
  if (value instanceof Map) return Object.fromEntries(value.entries());
  if (Array.isArray(value)) return Object.fromEntries(value.map((entry) => [entry.path, entry.content]));
  if (isObject(value)) return value;
  return null;
}

function reusableFiles(reuse, payloadClass) {
  if (!isObject(reuse) || !isObject(reuse.manifest) || !isObject(reuse.files)) return null;
  const entries = (reuse.manifest.inventory ?? []).filter((entry) => entry.payloadClass === payloadClass);
  if (entries.length === 0) return null;
  const files = {};
  for (const entry of entries) {
    if (typeof entry.path !== 'string' || reuse.files[entry.path] === undefined) return null;
    files[entry.path.slice(`payload/${payloadClass}/`.length)] = reuse.files[entry.path];
  }
  return files;
}

function reuseIsEligible(reuse, input, environment) {
  if (!isObject(reuse) || reuse.manifest?.producerSuccess !== true) return false;
  if (reuse.manifest.sourceSha !== input.sourceSha) return false;
  if (JSON.stringify(reuse.manifest.recursivePins ?? []) !== JSON.stringify(input.recursivePins)) return false;
  return JSON.stringify(reuse.manifest.compatibility) === JSON.stringify(normalizeCompatibility(environment, input.compatibility));
}

function materializedEntries(payloadClass, files, inventory, outputFiles) {
  for (const [relativePath, content] of Object.entries(files)) {
    const safePath = safeRelativePath(relativePath);
    if (!safePath) throw new Error(`materializer returned an unsafe path for ${payloadClass}`);
    const path = `payload/${payloadClass}/${safePath}`;
    if (outputFiles[path] !== undefined) throw new Error(`duplicate materialized path: ${path}`);
    outputFiles[path] = content;
    inventory.push({payloadClass, path, sha256: bytesDigest(content).slice('sha256:'.length)});
  }
  if (Object.keys(files).length === 0) throw new Error(`materializer returned no files for ${payloadClass}`);
}

function writeRelease(outputDir, manifest, files) {
  mkdirSync(outputDir, {recursive: true});
  if (readdirSync(outputDir).length > 0) throw new Error(`release output directory is not empty: ${outputDir}`);
  for (const [path, content] of Object.entries(files)) {
    const target = resolve(outputDir, path);
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, content);
  }
  writeFileSync(resolve(outputDir, RELEASE_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function collectProductionPayloads(payloadClasses, {reuse, materialize, outputDir, environment, profile}) {
  const files = {};
  const inventory = [];
  const materializedPayloadClasses = [];
  const reusedPayloadClasses = [];
  for (const payloadClass of payloadClasses) {
    const reused = reusableFiles(reuse, payloadClass);
    if (reused) {
      materializedEntries(payloadClass, reused, inventory, files);
      reusedPayloadClasses.push(payloadClass);
      continue;
    }
    const produced = asFileMap(await materialize({payloadClass, outputDir, environment, profile}));
    if (!produced) throw new Error(`materializer returned an invalid file map for ${payloadClass}`);
    materializedEntries(payloadClass, produced, inventory, files);
    materializedPayloadClasses.push(payloadClass);
  }
  return {files, inventory, materializedPayloadClasses, reusedPayloadClasses};
}

/**
 * Produce one immutable prerequisite release for the active profile.
 * The manifest is the producer identity; cache reuse only changes materialization counts.
 */
export async function producePrerequisiteRelease(input = {}) {
  const contract = readContract();
  const profile = normalizeProfile(contract, input.profile);
  if (!profile.ok) return profile;
  const union = payloadUnion(contract, profile.consumers);
  if (!union.ok) return union;
  const outputDir = input.outputDir ? resolve(input.outputDir) : null;
  if (!outputDir) return producerError('output-missing', {failedField: 'outputDir', expected: 'release output directory', observed: input.outputDir, hint: 'Provide a fresh output directory for the immutable release.'});
  if (typeof input.sourceSha !== 'string' || input.sourceSha.length === 0) return producerError('source-missing', {failedField: 'sourceSha', expected: 'editor source SHA', observed: input.sourceSha, hint: 'Provide the exact editor source SHA used by the producer.'});
  if (input.producerRunId === undefined || input.producerRunId === null || input.producerAttempt === undefined || input.producerAttempt === null) {
    return producerError('producer-attempt-missing', {failedField: 'producerRunId/producerAttempt', expected: 'run and attempt identity', observed: {producerRunId: input.producerRunId, producerAttempt: input.producerAttempt}, hint: 'Provide the workflow run and attempt identity for this producer execution.'});
  }

  const environment = normalizeEnvironment(input.environment);
  const materialize = input.materializePayload ?? defaultMaterialize;

  try {
    const recursivePins = input.recursivePins ?? deriveRecursivePins();
    const reuseInput = {...input, recursivePins};
    const reuse = reuseIsEligible(input.reuse, reuseInput, environment) ? input.reuse : null;
    const production = await collectProductionPayloads(union.payloadClasses, {
      reuse,
      materialize,
      outputDir,
      environment,
      profile: profile.profileName,
    });
    const {files, inventory, materializedPayloadClasses, reusedPayloadClasses} = production;
    const producerRunId = String(input.producerRunId);
    const producerAttempt = Number.isInteger(input.producerAttempt) ? input.producerAttempt : Number(input.producerAttempt);
    if (!Number.isInteger(producerAttempt) || producerAttempt < 1) throw new Error('producerAttempt must be a positive integer');
    const manifest = {
      schemaVersion: RELEASE_SCHEMA_VERSION,
      artifactId: `prerequisite-release-${producerRunId}-${producerAttempt}`,
      producerRunId,
      producerAttempt,
      sourceSha: input.sourceSha,
      recursivePins: structuredClone(recursivePins),
      producerSuccess: true,
      producerEnvironmentFingerprint: input.producerEnvironmentFingerprint ?? `${environment.os}-${environment.architecture}-${environment.capacityPool}`,
      compatibility: normalizeCompatibility(environment, input.compatibility),
      inventory,
      production: {
        event: 'prerequisite-release-produced',
        physicalProductionCount: 1,
        materializedPayloadClasses,
        reusedPayloadClasses,
      },
    };
    manifest.releaseDigest = digest(manifest);
    writeRelease(outputDir, manifest, files);
    return {
      ok: true,
      manifest,
      files,
      profile: profile.profileName,
      consumers: profile.consumers,
      payloadClasses: union.payloadClasses,
      materializedPayloadClasses,
      reusedPayloadClasses,
      validationInput: {
        manifest,
        files,
        sourceSha: input.sourceSha,
        recursivePins: structuredClone(recursivePins),
        producerRunId,
        producerAttempt,
        environment,
      },
    };
  } catch (error) {
    if (error.code === 'recursive-pin-derivation-failure') {
      return producerError(error.code, {
        failedField: 'recursivePins',
        expected: 'recursive submodule pin inventory',
        observed: error.message,
        hint: 'Run the producer from a valid recursive-submodule checkout and retry; do not publish a release without provenance.',
      });
    }
    return producerError(
      'producer-failure',
      {
        failedField: 'production',
        expected: 'complete immutable prerequisite release',
        observed: error.message ?? String(error),
        hint: 'Fix the producer input or materialization source and rerun; no partial release was published.',
      },
    );
  }
}

function requestedPayloadClasses(contract, input) {
  const declared = contract.prerequisiteRelease.consumers[input.consumer];
  if (!Array.isArray(declared)) {
    return reject(
      'consumer-unknown',
      input.manifest,
      input.consumer,
      {
        failedField: 'consumer',
        expected: Object.keys(contract.prerequisiteRelease.consumers),
        observed: input.consumer,
        hint: 'Use a consumer declared by the producer-owned prerequisiteRelease contract.',
      },
    );
  }
  const requested = input.requestedPayloadClasses ?? declared;
  const undeclared = requested.find((payloadClass) => !declared.includes(payloadClass));
  if (undeclared) {
    return reject(
      'undeclared-payload',
      input.manifest,
      input.consumer,
      {
        payloadClass: undeclared,
        expected: `${input.consumer} declares ${declared.join(', ')}`,
        observed: undeclared,
        hint: `Remove ${undeclared} from the ${input.consumer} request or add a named contract consumer declaration.`,
      },
    );
  }
  return {ok: true, value: [...requested]};
}

function validateManifestShape(manifest, consumer) {
  if (!isObject(manifest)) {
    return reject(
      'release-integrity-invalid',
      manifest,
      consumer,
      {
        failedField: 'manifest',
        expected: 'manifest object',
        observed: manifest,
        hint: 'Produce a complete prerequisite release manifest before running the consumer.',
      },
    );
  }
  if (manifest.schemaVersion !== RELEASE_SCHEMA_VERSION) {
    return reject(
      'release-integrity-invalid',
      manifest,
      consumer,
      {
        failedField: 'schemaVersion',
        expected: RELEASE_SCHEMA_VERSION,
        observed: manifest.schemaVersion,
        hint: 'Produce a release using the supported prerequisite manifest schema.',
      },
    );
  }
  return null;
}

function validateReleaseDigest(manifest, consumer) {
  const candidate = structuredClone(manifest);
  delete candidate.releaseDigest;
  const observedDigest = digest(candidate);
  if (observedDigest !== manifest.releaseDigest) {
    return reject(
      'release-integrity-invalid',
      manifest,
      consumer,
      {
        failedField: 'releaseDigest',
        expected: manifest.releaseDigest,
        observed: observedDigest,
        hint: 'Regenerate the immutable manifest digest; do not consume a changed release.',
      },
    );
  }
  return null;
}

function validateInventory(manifest, files, requested, consumer) {
  if (!Array.isArray(manifest.inventory) || !isObject(files)) {
    return reject(
      'release-integrity-invalid',
      manifest,
      consumer,
      {
        failedField: 'inventory',
        expected: 'manifest inventory and files object',
        observed: {inventory: manifest.inventory, files},
        hint: 'Publish the complete manifest inventory and materialized file map.',
      },
    );
  }
  const entriesByClass = new Map();
  const paths = new Set();
  for (const entry of manifest.inventory) {
    if (!isObject(entry) || typeof entry.payloadClass !== 'string' || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      return reject(
        'release-integrity-invalid',
        manifest,
        consumer,
        {
          failedField: 'inventory',
          expected: 'payloadClass, path, and sha256 for each entry',
          observed: entry,
          hint: 'Regenerate the release inventory from the published payload files.',
        },
      );
    }
    if (paths.has(entry.path)) {
      return reject(
        'release-integrity-invalid',
        manifest,
        consumer,
        {
          failedField: 'inventory',
          expected: 'unique manifest paths',
          observed: entry.path,
          hint: 'Remove duplicate payload paths from the immutable release inventory.',
        },
      );
    }
    paths.add(entry.path);
    const entries = entriesByClass.get(entry.payloadClass) ?? [];
    entries.push(entry);
    entriesByClass.set(entry.payloadClass, entries);
  }
  const filePaths = Object.keys(files);
  const extra = filePaths.find((path) => !paths.has(path));
  if (extra) {
    return reject(
      'release-integrity-invalid',
      manifest,
      consumer,
      {
        failedField: 'inventory',
        expected: 'manifest inventory matches files',
        observed: extra,
        hint: 'Remove unmanifested files or publish a new immutable release with the complete inventory.',
      },
    );
  }
  for (const entry of manifest.inventory) {
    if (files[entry.path] === undefined) {
      if (requested.includes(entry.payloadClass)) {
        return reject(
          'missing-payload',
          manifest,
          consumer,
          {
            payloadClass: entry.payloadClass,
            expected: `payload class ${entry.payloadClass} is present`,
            observed: 'missing',
            hint: `Produce the requested ${entry.payloadClass} payload before running ${consumer}.`,
          },
        );
      }
      continue;
    }
    if (!requested.includes(entry.payloadClass)) continue;
    const observed = bytesDigest(files[entry.path]);
    const expected = `sha256:${entry.sha256}`;
    if (observed !== expected) {
      return reject(
        'release-integrity-invalid',
        manifest,
        consumer,
        {
          failedField: 'payloadDigest',
          payloadClass: entry.payloadClass,
          expected,
          observed,
          hint: `Reproduce the ${entry.payloadClass} payload and publish a matching immutable digest.`,
        },
      );
    }
  }
  for (const payloadClass of requested) {
    if (!entriesByClass.has(payloadClass)) {
      return reject(
        'missing-payload',
        manifest,
        consumer,
        {
          payloadClass,
          expected: `payload class ${payloadClass} is present`,
          observed: 'missing',
          hint: `Produce the requested ${payloadClass} payload before running ${consumer}.`,
        },
      );
    }
  }
  return {ok: true, entriesByClass};
}

function validateProvenance(manifest, input) {
  if (manifest.producerSuccess !== true) {
    return reject(
      'producer-failure',
      manifest,
      input.consumer,
      {
        failedField: 'producerSuccess',
        expected: true,
        observed: manifest.producerSuccess,
        hint: 'Rerun the prerequisite producer and consume only a successful release attempt.',
      },
    );
  }
  if (manifest.sourceSha !== input.sourceSha) {
    return reject(
      'source-mismatch',
      manifest,
      input.consumer,
      {
        failedField: 'sourceSha',
        expected: manifest.sourceSha,
        observed: input.sourceSha,
        hint: 'Produce a release for the requested editor source SHA.',
      },
    );
  }
  if (manifest.producerRunId !== input.producerRunId || manifest.producerAttempt !== input.producerAttempt) {
    return reject(
      'attempt-mismatch',
      manifest,
      input.consumer,
      {
        failedField: 'producerAttempt',
        expected: manifest.producerAttempt,
        observed: input.producerAttempt,
        hint: 'Use the release produced by the current workflow run and attempt.',
      },
    );
  }
  const expectedPins = new Map((manifest.recursivePins ?? []).map((pin) => [pin.path, pin.pin]));
  const observedPins = new Map((input.recursivePins ?? []).map((pin) => [pin.path, pin.pin]));
  const pinPath = [...new Set([...expectedPins.keys(), ...observedPins.keys()])].find(
    (path) => expectedPins.get(path) !== observedPins.get(path),
  );
  if (pinPath) {
    return reject(
      'pin-mismatch',
      manifest,
      input.consumer,
      {
        failedField: 'recursivePins',
        expected: `${pinPath}=${expectedPins.get(pinPath)}`,
        observed: `${pinPath}=${observedPins.get(pinPath)}`,
        hint: 'Materialize the declared recursive submodule pins and produce a matching release.',
      },
    );
  }
  return null;
}

function validateCompatibility(manifest, environment, consumer) {
  const expected = manifest.compatibility;
  if (!isObject(expected) || !isObject(environment)) {
    return reject(
      'compatibility-mismatch',
      manifest,
      consumer,
      {
        failedField: 'compatibility',
        expected: 'manifest and consumer environment records',
        observed: {manifest: expected, environment},
        hint: 'Provide complete environment records for compatibility validation.',
      },
    );
  }
  for (const field of ['os', 'architecture', 'bunVersion', 'nodeVersion', 'pnpmVersion', 'rustVersion', 'wasmPackVersion']) {
    if (expected[field] !== undefined && expected[field] !== environment[field]) {
      return reject(
        'compatibility-mismatch',
        manifest,
        consumer,
        {
          failedField: field,
          expected: expected[field],
          observed: environment[field],
          hint: `Run ${consumer} in an environment compatible with the published release.`,
        },
      );
    }
  }
  if (Array.isArray(expected.capacityPool) && !expected.capacityPool.includes(environment.capacityPool)) {
    return reject(
      'compatibility-mismatch',
      manifest,
      consumer,
      {
        failedField: 'capacityPool',
        expected: expected.capacityPool,
        observed: environment.capacityPool,
        hint: `Run ${consumer} on an allowed capacity pool for the published release.`,
      },
    );
  }
  return null;
}

/**
 * Validate a named consumer against the producer release before its check body runs.
 * Missing, undeclared, incompatible, or mutated payloads return structured recovery data.
 */
export function validate(input) {
  const manifest = input?.manifest;
  const consumer = input?.consumer;
  const shapeError = validateManifestShape(manifest, consumer);
  if (shapeError) return shapeError;
  const contract = readContract();
  const payloadSelection = requestedPayloadClasses(contract, input);
  if (!payloadSelection.ok) return payloadSelection;
  const provenanceError = validateProvenance(manifest, input);
  if (provenanceError) return provenanceError;
  const compatibilityError = validateCompatibility(manifest, input.environment, consumer);
  if (compatibilityError) return compatibilityError;
  const inventoryResult = validateInventory(manifest, input.files, payloadSelection.value, consumer);
  if (!inventoryResult.ok) return inventoryResult;
  const releaseDigestError = validateReleaseDigest(manifest, consumer);
  if (releaseDigestError) return releaseDigestError;
  const payloadPaths = payloadSelection.value.flatMap((payloadClass) => (
    inventoryResult.entriesByClass.get(payloadClass).map((entry) => entry.path)
  ));
  const result = {
    ok: true,
    artifactId: manifest.artifactId,
    releaseDigest: manifest.releaseDigest,
    payloadClasses: payloadSelection.value,
    payloadPaths,
    manifest: structuredClone(manifest),
  };
  input.onValidated?.(result);
  return result;
}

function readReleaseFiles(manifestPath) {
  const releaseRoot = dirname(manifestPath);
  const files = listFiles(releaseRoot);
  delete files[RELEASE_MANIFEST_NAME];
  return files;
}

function cliError(code, consumer, failedField, expected, observed, hint, artifactId = null) {
  return errorResult(code, {
    affectedConsumer: consumer,
    artifactId,
    failedField,
    expected,
    observed,
    hint,
  });
}

function validateFromManifestPath(input) {
  const consumer = input.consumer;
  const manifestPath = input.manifestPath ? resolve(input.manifestPath) : null;
  if (!manifestPath) {
    return cliError(
      'manifest-missing',
      consumer,
      'manifestPath',
      'path to prerequisite release manifest',
      input.manifestPath,
      'Provide the downloaded prerequisite release manifest before entering the consumer check.',
    );
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const files = readReleaseFiles(manifestPath);
    const sourceSha = input.sourceSha ?? process.env.GITHUB_SHA;
    const producerRunId = input.producerRunId ?? process.env.GITHUB_RUN_ID;
    const producerAttempt = input.producerAttempt ?? process.env.GITHUB_RUN_ATTEMPT;
    const recursivePins = input.recursivePins ?? deriveRecursivePins();
    const result = validate({
      manifest,
      files,
      consumer,
      requestedPayloadClasses: input.requestedPayloadClasses,
      sourceSha,
      recursivePins,
      producerRunId,
      producerAttempt: producerAttempt === undefined ? undefined : Number(producerAttempt),
      environment: normalizeEnvironment(input.environment),
    });
    if (!result.ok) return result;
    return {
      ...result,
      consumer,
      sourceSha,
      recursivePins,
      producerRunId: String(producerRunId),
      producerAttempt: Number(producerAttempt),
      environment: normalizeEnvironment(input.environment),
    };
  } catch (error) {
    if (error.code === 'recursive-pin-derivation-failure') {
      return cliError(
        error.code,
        consumer,
        'recursivePins',
        'recursive submodule pin inventory',
        error.message,
        'Run validation from a valid recursive-submodule checkout before consuming the release.',
        null,
      );
    }
    return cliError(
      'manifest-read-failure',
      consumer,
      'manifestPath',
      'readable prerequisite release directory and manifest',
      error.message ?? String(error),
      'Download the immutable prerequisite release and rerun validation before using any payload.',
    );
  }
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function producerCliSummary(result) {
  if (!result.ok) return result;
  return {
    ok: true,
    artifactId: result.manifest.artifactId,
    releaseDigest: result.manifest.releaseDigest,
    profile: result.profile,
    consumers: result.consumers,
    payloadClasses: result.payloadClasses,
    materializedPayloadClasses: result.materializedPayloadClasses,
    reusedPayloadClasses: result.reusedPayloadClasses,
    production: result.manifest.production,
    inventoryCount: result.manifest.inventory.length,
  };
}

export function consumerCliSummary(result) {
  if (!result.ok) return result;
  return {
    ok: true,
    consumer: result.consumer,
    artifactId: result.artifactId,
    releaseDigest: result.releaseDigest,
    payloadClasses: result.payloadClasses,
    payloadPaths: result.payloadPaths,
    sourceSha: result.sourceSha,
    recursivePins: result.recursivePins,
    producerRunId: result.producerRunId,
    producerAttempt: result.producerAttempt,
    compatibility: {status: 'compatible'},
    validation: {status: 'pass', consumer: result.consumer, payloadClasses: result.payloadClasses},
  };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    process.stdout.write('Usage: bun run ci:prerequisite -- produce --output <release-dir> --profile <profile> --source-sha <sha> --run-id <id> --attempt <number>\n');
    process.stdout.write('       bun run ci:prerequisite -- validate --manifest <path> --consumer <consumer> [--source-sha <sha>] [--run-id <id>] [--attempt <number>]\n');
    return;
  }
  if (argv[0] === 'validate') {
    const result = validateFromManifestPath({
      manifestPath: argumentValue(argv, '--manifest'),
      consumer: argumentValue(argv, '--consumer'),
      sourceSha: argumentValue(argv, '--source-sha'),
      producerRunId: argumentValue(argv, '--run-id'),
      producerAttempt: argumentValue(argv, '--attempt'),
    });
    process.stdout.write(`${JSON.stringify(consumerCliSummary(result), null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (argv[0] !== 'produce') {
    process.stdout.write('Usage: bun run ci:prerequisite -- produce ... | validate --manifest <path> --consumer <consumer>\n');
    process.exitCode = 1;
    return;
  }
  const result = await producePrerequisiteRelease({
    outputDir: argumentValue(argv, '--output'),
    profile: argumentValue(argv, '--profile'),
    sourceSha: argumentValue(argv, '--source-sha'),
    producerRunId: argumentValue(argv, '--run-id'),
    producerAttempt: Number(argumentValue(argv, '--attempt')),
    producerEnvironmentFingerprint: process.env.CI_ENVIRONMENT_FINGERPRINT,
    environment: {
      bunVersion: process.env.CI_BUN_VERSION,
      nodeVersion: process.env.CI_NODE_VERSION,
      pnpmVersion: process.env.CI_PNPM_VERSION,
      rustVersion: process.env.CI_RUST_TOOLCHAIN,
      wasmPackVersion: process.env.CI_WASM_PACK_VERSION,
      capacityPool: process.env.CI_CAPACITY_POOL ?? 'standard',
    },
  });
  process.stdout.write(`${JSON.stringify(producerCliSummary(result), null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

export const validatePrerequisiteRelease = validate;
export const produce = producePrerequisiteRelease;

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) main();
