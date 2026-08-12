import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export const PORTFOLIO_SCHEMA_VERSION = 'forgeax-browser-release-portfolio/v1';
export const EVIDENCE_SCHEMA_VERSION = 'forgeax-browser-release-evidence/v1';
export const PORTFOLIO_PARENT_CHECK_ID = 'smoke-play';
export const REQUIRED_UNIT_COUNT = 6;
export const DISCOVERY_CHANNELS = Object.freeze(['typeScript', 'typeErased', 'json']);

function issue(code, expected, observed, hint) {
  return { code, expected, observed, hint };
}

function result(errors = [], value) {
  return value === undefined
    ? { ok: errors.length === 0, errors }
    : { ok: errors.length === 0, errors, value };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalCandidateId(path) {
  return `candidate-${sha256(`${path}\n`).slice(0, 24)}`;
}

function isPathWithin(root, path) {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath === '' || (
    !isAbsolute(relativePath) &&
    !/^(?:\.\.(?:[\\/]|$))/.test(relativePath)
  );
}

function gitFiles(root) {
  if (!existsSync(root)) return null;
  try {
    const resolvedRoot = resolve(root);
    const repoRoot = resolve(execFileSync('git', ['-C', resolvedRoot, 'rev-parse', '--show-toplevel'], {encoding: 'utf8'}).trim());
    return execFileSync('git', ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {encoding: 'utf8'})
      .split('\0')
      .filter(Boolean)
      .map((path) => resolve(repoRoot, path))
      .filter((path) => existsSync(path))
      .filter((path) => isPathWithin(resolvedRoot, path))
      .map((path) => ({path, relativePath: relative(resolvedRoot, path)}))
      .filter(({relativePath}) => {
        return relativePath === '' || (!isAbsolute(relativePath) && !relativePath.split(/[/\\]/).some((part) => ['.git', 'dist', 'node_modules'].includes(part)));
      })
      .map(({path}) => path);
  } catch {
    return null;
  }
}

function walkFiles(root, predicate, output = []) {
  const resolvedRoot = resolve(root);
  const repositoryFiles = gitFiles(resolvedRoot);
  if (repositoryFiles) return repositoryFiles.filter(predicate).sort();
  if (!existsSync(resolvedRoot)) return output;
  for (const entry of readdirSync(resolvedRoot, { withFileTypes: true })) {
    if (['.git', 'dist', 'node_modules'].includes(entry.name)) continue;
    const path = resolve(resolvedRoot, entry.name);
    if (!isPathWithin(resolvedRoot, path)) continue;
    if (entry.isDirectory()) walkFiles(path, predicate, output);
    else if (predicate(path)) output.push(path);
  }
  return output.sort();
}

function relativePath(root, path) {
  return relative(root, path).split('\\').join('/');
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function sourcePathsFromRun(run) {
  return run
    .replaceAll('\\\n', ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^['"]|['"]$/g, '').replace(/[;,]$/, ''))
    .filter((token) => /^(?:(?:e2e|apps\/standalone\/e2e|scripts))\/.+\.(?:ts|tsx|js|mjs|cjs)$/.test(token));
}

function visitWorkflow(value, callback) {
  if (Array.isArray(value)) return value.forEach((entry) => visitWorkflow(entry, callback));
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'run' || key === 'command') && typeof child === 'string') callback(child);
    else visitWorkflow(child, callback);
  }
}

function workflowSources(root) {
  const files = walkFiles(join(root, '.github', 'workflows'), (path) => /\.ya?ml$/.test(path));
  const invocations = [];
  for (const file of files) {
    const document = (() => {
      try {
        return parseYaml(readText(file));
      } catch {
        return null;
      }
    })();
    visitWorkflow(document, (run) => {
      for (const source of sourcePathsFromRun(run)) {
        invocations.push({ path: relativePath(root, file), source, invocation: run });
      }
    });
  }
  return invocations.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function packageSources(root) {
  const packagePath = join(root, 'package.json');
  let packageJson = {};
  try {
    packageJson = JSON.parse(readText(packagePath));
  } catch {
    return [];
  }
  return Object.entries(packageJson.scripts ?? {})
    .filter(([name, command]) => /(?:test:e2e|test:j[45]|static-build-smoke|repro-default-scene)/.test(`${name} ${command}`))
    .flatMap(([name, command]) => sourcePathsFromRun(command).map((source) => ({name, command, source})));
}

function channelFiles(root) {
  return {
    typeScript: walkFiles(root, (path) => /\.(?:ts|tsx)$/.test(path)),
    typeErased: [
      ...walkFiles(root, (path) => /\.(?:mjs|cjs)$/.test(path)),
      ...walkFiles(join(root, 'scripts', 'ci', 'fixtures'), () => true),
    ].filter((path, index, paths) => paths.indexOf(path) === index),
    json: [
      ...walkFiles(root, (path) => /\.(?:pack|meta|config)\.json$/.test(path)),
      join(root, 'scripts', 'ci', 'editor-ci-contract.json'),
    ].filter((path, index, paths) => existsSync(path) && paths.indexOf(path) === index),
  };
}

function scanChannels(root, ownedSources) {
  const files = channelFiles(root);
  return Object.fromEntries(DISCOVERY_CHANNELS.map((channel) => {
    const paths = files[channel].map((path) => relativePath(root, path));
    const matchedFiles = paths.filter((path, index) => {
      const text = readText(files[channel][index]);
      return ownedSources.some((source) => text.includes(source)) || text.includes('browserReleasePortfolio');
    });
    return [channel, {files: paths, matchedFiles}];
  }));
}

function candidatePaths(root, specs, scripts, packageEntries, workflows) {
  return [...new Set([
    ...specs,
    ...scripts,
    ...packageEntries.map((entry) => `package.json#scripts.${entry.name}`),
    ...workflows.map((entry) => `${entry.path}#${entry.source}`),
  ])].sort();
}

export function discoverBrowserReleaseCandidates(rootDir = process.cwd(), portfolio = null) {
  const root = resolve(rootDir);
  const specRoots = ['apps/standalone/e2e', 'e2e']
    .map((relativeRoot) => join(root, relativeRoot))
    .filter((path) => existsSync(path));
  const specs = [...new Set(specRoots.flatMap((specRoot) => (
    walkFiles(specRoot, (path) => /\.(?:spec|test)\.(?:ts|tsx|js|mjs|cjs)$/.test(path))
      .map((path) => relativePath(root, path))
  )))].sort();
  const scripts = walkFiles(join(root, 'scripts'), (path) => /\.(?:mjs|cjs)$/.test(path)).map((path) => relativePath(root, path));
  const packageEntries = packageSources(root);
  const workflows = workflowSources(root);
  const ownedSources = portfolio?.discovery?.ownedSources ?? [];
  const paths = candidatePaths(root, specs, scripts, packageEntries, workflows);
  const candidates = paths.map((path) => ({
    candidateId: canonicalCandidateId(path),
    path,
    disposition: ownedSources.includes(path) ? 'retained' : 'structured-exclusion',
  }));
  const exclusions = candidates
    .filter((candidate) => candidate.disposition === 'structured-exclusion')
    .map((candidate) => ({
      candidateId: candidate.candidateId,
      path: candidate.path,
      owner: portfolio?.discovery?.exclusionOwner ?? 'editor-ci',
      exclusionClass: portfolio?.discovery?.exclusionClass ?? 'not-release-owned',
      rationale: 'The current producer contract does not bind this census candidate to a retained unit.',
    }));
  return {
    schemaVersion: 'forgeax-browser-release-census/v1',
    root,
    counts: {specs: specs.length, scripts: scripts.length, packageEntries: packageEntries.length, workflowSources: workflows.length, candidates: candidates.length},
    specs,
    scripts,
    packageEntries,
    workflows,
    channels: scanChannels(root, ownedSources),
    candidates,
    exclusions,
  };
}

function validatePortfolioShape(portfolio) {
  if (!isObject(portfolio)) return issue('portfolio-root-invalid', 'a producer-owned portfolio object', portfolio, 'Read browserReleasePortfolio from the CI contract before discovery.');
  if (portfolio.schemaVersion !== PORTFOLIO_SCHEMA_VERSION) return issue('portfolio-schema-version', PORTFOLIO_SCHEMA_VERSION, portfolio.schemaVersion, 'Use the supported browser release portfolio schema.');
  if (portfolio.owner !== 'editor-ci') return issue('portfolio-owner-unresolved', 'editor-ci', portfolio.owner, 'Resolve producer ownership in the current contract before discovering units.');
  if (portfolio.parentCheckId !== PORTFOLIO_PARENT_CHECK_ID) return issue('portfolio-parent-invalid', PORTFOLIO_PARENT_CHECK_ID, portfolio.parentCheckId, 'Keep every child projected to smoke-play.');
  if (!Array.isArray(portfolio.discovery?.ownedSources)) return issue('portfolio-source-list-invalid', 'six producer-owned source paths', portfolio.discovery?.ownedSources, 'Regenerate the producer source selection before discovery.');
  if (portfolio.discovery.ownedSources.length !== REQUIRED_UNIT_COUNT) return issue('unit-set-mismatch', REQUIRED_UNIT_COUNT, portfolio.discovery.ownedSources.length, 'Update the producer-owned source selection and rerun the current census.');
  return null;
}

function unitProfile(path) {
  return path.startsWith('scripts/') ? 'release-script' : 'browser-journey';
}

function projectUnit(candidate, portfolio) {
  const profile = unitProfile(candidate.path);
  return {
    unitId: `browser-release-${candidate.candidateId.slice('candidate-'.length)}`,
    source: {path: candidate.path, entryPoint: `census:${candidate.path}`},
    parentCheckId: portfolio.parentCheckId,
    owner: portfolio.owner,
    profile,
    disposition: 'retained',
    evidence: {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      requiredFields: [...portfolio.evidence.requiredFields],
      failureFields: [...portfolio.evidence.failureFields],
    },
  };
}

function validateChannelRecords(discovery) {
  for (const channel of DISCOVERY_CHANNELS) {
    const record = discovery.channels?.[channel];
    if (!isObject(record) || !Array.isArray(record.files) || !Array.isArray(record.matchedFiles)) {
      return issue('discovery-channel-record-missing', 'files and matchedFiles arrays for every scan channel', record ?? 'missing', `Record the ${channel} scan as a file list or an explicit no-hit list.`);
    }
  }
  return null;
}

function validateCandidateIdentity(discovery) {
  const ids = new Set();
  for (const candidate of discovery.candidates) {
    if (!isObject(candidate) || !nonEmpty(candidate.path)) return issue('candidate-record-invalid', 'candidate path and identity', candidate, 'Regenerate candidate records from the live census.');
    if (ids.has(candidate.candidateId)) return issue('candidate-id-duplicate', 'one candidateId per discovered path', candidate.candidateId, 'Deduplicate the census before projecting units.');
    if (candidate.candidateId !== canonicalCandidateId(candidate.path)) return issue('candidate-id-drift', canonicalCandidateId(candidate.path), candidate.candidateId, 'Recompute candidate identity from the normalized source path.');
    ids.add(candidate.candidateId);
  }
  return null;
}

function validateSourceDispositions(discovery, portfolio) {
  const owned = new Set(portfolio.discovery.ownedSources);
  const candidates = new Map(discovery.candidates.map((candidate) => [candidate.path, candidate]));
  const missing = [...owned].filter((path) => !candidates.has(path));
  if (missing.length > 0) return issue('unit-set-mismatch', [...owned].sort(), missing, 'Restore every producer-owned source to the live census; do not use a historical unit ID.');
  for (const candidate of discovery.candidates) {
    const expected = owned.has(candidate.path) ? 'retained' : 'structured-exclusion';
    if (candidate.disposition !== expected) return issue('candidate-disposition-drift', expected, candidate.disposition, `Align the source disposition for ${candidate.path} with the current producer contract.`);
  }
  return null;
}

function validateExclusions(discovery) {
  const candidates = new Set(discovery.candidates.map((candidate) => candidate.candidateId));
  const exclusions = new Set();
  for (const exclusion of discovery.exclusions ?? []) {
    if (!isObject(exclusion) || !nonEmpty(exclusion.candidateId) || !nonEmpty(exclusion.path)) return issue('discovery-exclusion-invalid', 'candidateId and path', exclusion, 'Record a complete structured disposition for every excluded candidate.');
    if (!candidates.has(exclusion.candidateId)) return issue('discovery-exclusion-stale', 'an exclusion for one live candidate', exclusion, 'Refresh exclusions after the live census changes.');
    if (exclusions.has(exclusion.candidateId)) return issue('discovery-exclusion-duplicate', 'one exclusion per candidateId', exclusion.candidateId, 'Remove duplicate source dispositions.');
    exclusions.add(exclusion.candidateId);
  }
  const retainedIds = new Set(discovery.candidates.filter((candidate) => candidate.disposition === 'retained').map((candidate) => candidate.candidateId));
  const missing = discovery.candidates.find((candidate) => candidate.disposition === 'structured-exclusion' && !exclusions.has(candidate.candidateId));
  if (missing) return issue('candidate-orphan', 'a structured exclusion for every unmatched candidate', missing, 'Persist the current source disposition with candidate identity and rationale.');
  const double = [...exclusions].find((candidateId) => retainedIds.has(candidateId));
  if (double) return issue('candidate-double-disposition', 'retained candidates have no exclusion', double, 'Remove the exclusion when the producer contract retains the source.');
  return null;
}

function validateCandidateSet(discovery) {
  const expected = candidatePaths(discovery.root, discovery.specs ?? [], discovery.scripts ?? [], discovery.packageEntries ?? [], discovery.workflows ?? []);
  const observed = discovery.candidates.map((candidate) => candidate.path).sort();
  if (JSON.stringify(expected) !== JSON.stringify(observed)) return issue('discovery-candidate-set-drift', expected, observed, 'Rebuild the candidate set from the three source channels and current workflow/package census.');
  return null;
}

function buildUnits(discovery, portfolio) {
  const units = discovery.candidates
    .filter((candidate) => candidate.disposition === 'retained')
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((candidate) => projectUnit(candidate, portfolio));
  if (units.length !== REQUIRED_UNIT_COUNT) return issue('unit-set-mismatch', REQUIRED_UNIT_COUNT, units.length, 'Only the current producer-owned census may produce the six-unit portfolio.');
  return units;
}

export function validateBrowserReleaseDiscovery(discovery, portfolio) {
  const portfolioIssue = validatePortfolioShape(portfolio);
  if (portfolioIssue) return result([portfolioIssue]);
  if (!isObject(discovery) || !Array.isArray(discovery.candidates)) return result([issue('discovery-root-invalid', 'a candidate census', discovery, 'Run the dynamic browser/release census before projection.')]);
  const channelIssue = validateChannelRecords(discovery);
  if (channelIssue) return result([channelIssue]);
  const identityIssue = validateCandidateIdentity(discovery);
  if (identityIssue) return result([identityIssue]);
  const dispositionIssue = validateSourceDispositions(discovery, portfolio);
  if (dispositionIssue) return result([dispositionIssue]);
  const exclusionIssue = validateExclusions(discovery);
  if (exclusionIssue) return result([exclusionIssue]);
  const setIssue = validateCandidateSet(discovery);
  if (setIssue) return result([setIssue]);
  const units = buildUnits(discovery, portfolio);
  if (!Array.isArray(units)) return result([units]);
  return result([], {...structuredClone(discovery), units});
}

export function validateEvidenceEnvelope(observed, expected) {
  if (!isObject(observed)) return result([issue('evidence-envelope-invalid', expected, observed, 'Regenerate the structured evidence envelope instead of parsing log text.')]);
  for (const field of ['sourceSha', 'contractDigest', 'admissionGeneration', 'terminalStatus']) {
    if (observed[field] !== expected[field]) {
      const code = field === 'admissionGeneration' ? 'admission-drift' : field === 'contractDigest' ? 'stale-artifact' : 'evidence-provenance-drift';
      return result([issue(code, {[field]: expected[field]}, {[field]: observed[field]}, `Regenerate the artifact from admission generation ${expected.admissionGeneration} and do not reuse stale evidence.`)]);
    }
  }
  return result();
}

export const MEASUREMENT_INDEX_SCHEMA_VERSION = 'forgeax-browser-release-measurement-index/v1';
export const AGGREGATE_SCHEMA_VERSION = 'forgeax-browser-release-aggregate/v1';
export const TOPOLOGY_SCHEMA_VERSION = 'forgeax-browser-release-topology/v1';

function jsonDigest(value) {
  return sha256(`${JSON.stringify(value)}\n`);
}

function hexDigest(value, length = 64) {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
}

function expectedIndexFields(options) {
  const expected = options?.expected ?? {};
  return {
    sourceSha: expected.sourceSha,
    contractDigest: expected.contractDigest,
    workflowDigest: expected.workflowDigest,
    admissionDigest: expected.admissionDigest,
    admissionGeneration: expected.admissionGeneration,
    admitted: expected.admitted,
  };
}

function indexIssue(code, expected, observed, hint) {
  return issue(code, expected, observed, hint);
}

function validateIndexProvenance(index, options) {
  const expected = expectedIndexFields(options);
  for (const field of ['sourceSha', 'contractDigest', 'admissionDigest']) {
    if (!nonEmpty(index[field]) || (nonEmpty(expected[field]) && index[field] !== expected[field])) {
      return indexIssue('measurement-provenance-drift', expected[field] ?? 'non-empty current value', index[field], 'Regenerate every raw artifact from the same immutable admission.');
    }
  }
  if (nonEmpty(expected.workflowDigest) && index.workflowDigest !== expected.workflowDigest) return indexIssue('measurement-provenance-drift', expected.workflowDigest, index.workflowDigest, 'Bind the index to the workflow digest from the current admission.');
  if (index.admissionGeneration !== expected.admissionGeneration) return indexIssue('measurement-generation-drift', expected.admissionGeneration, index.admissionGeneration, 'Discard mixed-generation artifacts and rerun the complete current index.');
  if (!Number.isInteger(index.admissionGeneration)) return indexIssue('measurement-generation-invalid', 'an integer admission generation', index.admissionGeneration, 'Record the immutable admission generation in every raw and index artifact.');
  if (expected.admitted && JSON.stringify(index.admitted) !== JSON.stringify(expected.admitted)) return indexIssue('measurement-admission-drift', expected.admitted, index.admitted, 'Keep the editor and recursive submodule SHAs bound to the same immutable admission.');
  return null;
}

function canonicalUnitSources(portfolio) {
  return [...new Set(portfolio.discovery.ownedSources)].sort();
}

function validateIndexUnits(index, portfolio) {
  const expectedSources = canonicalUnitSources(portfolio);
  if (!Array.isArray(index.units)) return indexIssue('measurement-unit-set-invalid', expectedSources, index.units, 'Build one indexed unit from each producer-owned source.');
  const ids = new Set();
  const sources = new Set();
  for (const unit of index.units) {
    if (!isObject(unit) || !nonEmpty(unit.unitId) || !isObject(unit.source) || !nonEmpty(unit.source.path)) return indexIssue('measurement-unit-invalid', 'unitId and source.path', unit, 'Retain canonical unit identity and source provenance in the index.');
    if (ids.has(unit.unitId)) return indexIssue('measurement-unit-duplicate', 'one index row per canonical unit', unit.unitId, 'Remove duplicate raw/sample projections before aggregate.');
    if (sources.has(unit.source.path)) return indexIssue('measurement-source-duplicate', 'one canonical source per unit', unit.source.path, 'Do not map two unit IDs to the same current source.');
    if (!expectedSources.includes(unit.source.path)) return indexIssue('measurement-unit-unknown', expectedSources, unit.source.path, 'Resolve units from the current producer-owned contract.');
    if (unit.parentCheckId !== PORTFOLIO_PARENT_CHECK_ID) return indexIssue('measurement-parent-invalid', PORTFOLIO_PARENT_CHECK_ID, unit.parentCheckId, 'Project every measurement child to the existing smoke-play parent.');
    if (unit.terminalStatus !== 'pass') return indexIssue('measurement-not-terminal', 'pass', unit.terminalStatus, 'Only terminal pass raw evidence can enter final projection.');
    if (!Array.isArray(unit.sampleIds) || !unit.sampleIds.includes('sample-1')) return indexIssue('measurement-raw-missing', 'sample-1 raw evidence for every unit', unit.sampleIds, 'Retain the raw artifact and rerun index validation.');
    for (const digest of unit.rawDigests ?? []) if (!hexDigest(digest)) return indexIssue('measurement-artifact-digest-invalid', '64 lowercase hex digest', digest, 'Compute the raw artifact digest from the exact downloaded file.');
    ids.add(unit.unitId);
    sources.add(unit.source.path);
  }
  if (index.units.length !== expectedSources.length) return indexIssue('measurement-unit-set-drift', expectedSources.length, index.units.length, 'Do not fill a missing unit from a historical roster; rerun live discovery.');
  if (JSON.stringify(index.canonicalOrder) !== JSON.stringify([...index.units].sort((a, b) => a.unitId.localeCompare(b.unitId)).map((unit) => unit.unitId))) return indexIssue('measurement-canonical-order-invalid', [...ids].sort(), index.canonicalOrder, 'Sort the index by canonical unitId before writing the artifact.');
  if (sources.size !== expectedSources.length) return indexIssue('measurement-unit-set-drift', expectedSources, [...sources].sort(), 'The live source-to-index mapping is incomplete.');
  return null;
}

function validateIndexSamples(index) {
  if (!Array.isArray(index.samples)) return indexIssue('measurement-sample-set-invalid', 'sample rows for every indexed unit', index.samples, 'Retain raw/sample provenance in the index.');
  const keys = new Set();
  for (const sample of index.samples) {
    if (!isObject(sample) || !nonEmpty(sample.unitId) || !nonEmpty(sample.sampleId)) return indexIssue('measurement-sample-invalid', 'unitId and sampleId', sample, 'Record the sample identity and raw digest.');
    const key = `${sample.unitId}:${sample.sampleId}`;
    if (keys.has(key)) return indexIssue('measurement-sample-duplicate', 'one sample row per unit and sample', key, 'Remove duplicate downloaded artifacts.');
    if (sample.terminalStatus !== 'pass') return indexIssue('measurement-not-terminal', 'pass', sample.terminalStatus, 'A nonterminal or failed raw artifact keeps the index non-pass.');
    if (!hexDigest(sample.rawDigest)) return indexIssue('measurement-artifact-digest-invalid', '64 lowercase hex digest', sample.rawDigest, 'Use the digest of the raw artifact, not a copied report digest.');
    keys.add(key);
  }
  const unitIds = new Set(index.units.map((unit) => unit.unitId));
  for (const unitId of unitIds) if (!keys.has(`${unitId}:sample-1`)) return indexIssue('measurement-raw-missing', `${unitId}:sample-1`, [...keys], 'Every indexed unit needs one current terminal sample-1 raw artifact.');
  return null;
}

export function validateMeasurementIndex(index, portfolio, options = {}) {
  const portfolioIssue = validatePortfolioShape(portfolio);
  if (portfolioIssue) return result([portfolioIssue]);
  if (!isObject(index) || index.schemaVersion !== MEASUREMENT_INDEX_SCHEMA_VERSION) return result([indexIssue('measurement-index-schema-invalid', MEASUREMENT_INDEX_SCHEMA_VERSION, index?.schemaVersion, 'Use the current machine-readable measurement index schema.')]);
  if (index.status !== 'pass') return result([indexIssue('measurement-index-not-pass', 'pass', index.status, 'Complete all canonical terminal measurements before aggregate or transfer.')]);
  const provenanceIssue = validateIndexProvenance(index, options);
  if (provenanceIssue) return result([provenanceIssue]);
  if (!isObject(index.attestor) || index.attestor.verified !== true || !hexDigest(index.attestor.fingerprint)) return result([indexIssue('measurement-attestation-missing', 'verified attestor fingerprint', index.attestor ?? null, 'Validate raw signatures with the current measurement attestor before accepting the index.')]);
  const unitIssue = validateIndexUnits(index, portfolio);
  if (unitIssue) return result([unitIssue]);
  const sampleIssue = validateIndexSamples(index);
  if (sampleIssue) return result([sampleIssue]);
  const value = structuredClone(index);
  value.phase = 'measured';
  delete value.measurementDigest;
  value.measurementDigest = jsonDigest(value);
  return result([], value);
}

function aggregateUnitIssue(code, expected, observed, hint) {
  return issue(code, expected, observed, hint);
}

export function aggregateUnitResults(index, portfolio) {
  if (!isObject(index)) return result([aggregateUnitIssue('aggregate-index-missing', 'a validated measurement index', index, 'Run measurement index validation before aggregate.')]);
  const expectedSources = canonicalUnitSources(portfolio);
  const units = Array.isArray(index.units) ? index.units : [];
  const ids = units.map((unit) => unit?.unitId);
  if (new Set(ids).size !== ids.length) return result([aggregateUnitIssue('aggregate-unit-duplicate', 'one unit result per canonical unit', ids, 'Remove duplicate unit rows before aggregate.')]);
  if (units.some((unit) => !expectedSources.includes(unit?.source?.path))) return result([aggregateUnitIssue('aggregate-unit-unknown', expectedSources, units, 'Reject units outside the current producer-owned contract.')]);
  if (units.length !== expectedSources.length) return result([aggregateUnitIssue('aggregate-unit-missing', expectedSources.length, units.length, 'Retain measured/pre-topology state and rerun the missing canonical unit.')]);
  const failed = units.find((unit) => unit.terminalStatus !== 'pass');
  if (failed) return result([aggregateUnitIssue('aggregate-unit-not-pass', 'every canonical unit terminal pass', failed, 'Rerun only the failed unit under the same admission; do not make a final claim.')]);
  const measurementDigest = index.measurementDigest ?? jsonDigest(index);
  const aggregate = {
    schemaVersion: AGGREGATE_SCHEMA_VERSION,
    phase: 'measured',
    status: 'pass',
    sourceSha: index.sourceSha,
    contractDigest: index.contractDigest,
    workflowDigest: index.workflowDigest,
    admissionDigest: index.admissionDigest,
    admissionGeneration: index.admissionGeneration,
    measurementDigest,
    units: structuredClone(units),
    topology: {
      schemaVersion: TOPOLOGY_SCHEMA_VERSION,
      phase: 'pre-topology',
      status: 'provisional',
      provisionalHome: 'feature-pr-measurement',
      provisionalRunner: 'self-hosted-linux-x64-heavy',
      measurementDigest,
      units: [],
    },
  };
  return result([], aggregate);
}

export function projectPortfolioTopology(index, portfolio, options = {}) {
  const aggregateResult = options.aggregate ? result([], options.aggregate) : aggregateUnitResults(index, portfolio);
  if (!aggregateResult.ok) return aggregateResult;
  if (index?.status !== 'pass') return result([issue('topology-index-not-pass', 'pass', index?.status, 'Do not project topology from a failed or focused-only index.')]);
  if (options.phase && options.phase !== 'projected') return result([issue('topology-phase-invalid', 'projected', options.phase, 'Final home is only writable during the projected phase.')]);
  if (options.finalHome !== undefined && options.finalHome !== null) return result([issue('topology-phase-invalid', 'no final home before projection', options.finalHome, 'Keep provisional home until the same-generation index is projected.')]);
  if (options.snapshot && options.snapshot.sourceSha !== index.sourceSha) return result([issue('topology-snapshot-stale', index.sourceSha, options.snapshot.sourceSha, 'Discard the old snapshot and derive topology from the current measurement index.')]);
  const aggregate = aggregateResult.value;
  const units = aggregate.units.map((unit, indexValue) => ({
    unitId: unit.unitId,
    source: structuredClone(unit.source),
    parentCheckId: PORTFOLIO_PARENT_CHECK_ID,
    executionGroup: `measurement-${indexValue + 1}`,
    home: 'evidence-final',
  }));
  return result([], {
    ...aggregate,
    schemaVersion: AGGREGATE_SCHEMA_VERSION,
    phase: 'projected',
    topology: {
      schemaVersion: TOPOLOGY_SCHEMA_VERSION,
      phase: 'projected',
      status: 'final',
      sourceSha: index.sourceSha,
      contractDigest: index.contractDigest,
      workflowDigest: index.workflowDigest,
      admissionDigest: index.admissionDigest,
      admissionGeneration: index.admissionGeneration,
      measurementDigest: aggregate.measurementDigest,
      transferDigest: null,
      provisionalHome: null,
      provisionalRunner: null,
      units,
    },
  });
}

export function validateFinalProjection(projected, index, portfolio) {
  if (!isObject(projected?.topology) || projected.phase !== 'projected' || projected.topology.phase !== 'projected' || projected.topology.status !== 'final') return result([issue('final-topology-phase-invalid', 'projected final topology', projected?.topology, 'Only a projected topology can carry a final claim.')]);
  if (index?.status !== 'pass') return result([issue('final-claim-index-not-pass', 'pass', index?.status, 'Keep the final claim blocked until the current index passes.')]);
  const expectedMeasurementDigest = index.measurementDigest ?? jsonDigest({...index, measurementDigest: undefined});
  for (const field of ['sourceSha', 'contractDigest', 'workflowDigest', 'admissionDigest', 'admissionGeneration']) {
    if (projected.topology[field] !== index[field]) return result([issue('final-topology-provenance-drift', index[field], projected.topology[field], 'Final topology must reference the exact current index provenance.')]);
  }
  if (projected.topology.measurementDigest !== expectedMeasurementDigest) return result([issue('final-topology-digest-drift', expectedMeasurementDigest, projected.topology.measurementDigest, 'Final topology must reference the exact current measurement index digest.')]);
  if (projected.topology.transferDigest !== null) return result([issue('final-topology-digest-drift', null, projected.topology.transferDigest, 'Transfer digest is not available until the independent live transfer gate passes.')]);
  if (projected.topology.provisionalHome !== null || projected.topology.provisionalRunner !== null) return result([issue('final-topology-provisional-home', null, {home: projected.topology.provisionalHome, runner: projected.topology.provisionalRunner}, 'Clear provisional home and runner only after final projection.')]);
  const expectedSources = canonicalUnitSources(portfolio);
  if (!Array.isArray(projected.topology.units) || projected.topology.units.length !== expectedSources.length) return result([issue('final-topology-unit-set-invalid', expectedSources.length, projected.topology.units, 'Final topology must contain every current canonical unit exactly once.')]);
  const missingGroup = projected.topology.units.find((unit) => !nonEmpty(unit.executionGroup));
  if (missingGroup) return result([issue('final-topology-execution-group-missing', 'executionGroup for every unit', missingGroup, 'Attach final execution evidence to every canonical unit.')]);
  if (projected.topology.units.some((unit) => unit.parentCheckId !== PORTFOLIO_PARENT_CHECK_ID)) return result([issue('final-topology-parent-invalid', PORTFOLIO_PARENT_CHECK_ID, projected.topology.units, 'Keep the existing smoke-play parent as the only aggregate parent.')]);
  return result([], projected);
}

export function validateBrowserReleasePortfolio(portfolio, options = {}) {
  const portfolioIssue = validatePortfolioShape(portfolio);
  if (portfolioIssue) return result([portfolioIssue]);
  if (options.discovery) return validateBrowserReleaseDiscovery(options.discovery, portfolio);
  return result();
}
