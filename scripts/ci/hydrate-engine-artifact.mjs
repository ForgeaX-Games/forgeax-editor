import {execFileSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const DEFAULT_ENGINE_REPOSITORY = 'ForgeaX-Games/forgeax-engine';
const DEFAULT_ENGINE_WORKFLOW_PATH = '.github/workflows/ci.yml';
const CORE_ARTIFACT_NAME = /^core-build-a(\d+)(?:-retry-[12]-a\d+)?$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failure(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

/**
 * Flatten GitHub REST page fixtures. The live CLI path uses `--paginate --jq`
 * for compatibility with the older `gh` installed on the self-hosted runner;
 * tests may still provide a single page or an already flattened array.
 */
export function flattenCollection(value, collectionKey) {
  const pages = Array.isArray(value) ? value : [value];
  const result = [];
  for (const page of pages) {
    if (Array.isArray(page)) {
      result.push(...page);
      continue;
    }
    if (isObject(page) && Array.isArray(page[collectionKey])) result.push(...page[collectionKey]);
  }
  return result;
}

function timestamp(value) {
  return Date.parse(value ?? '') || 0;
}

function runAttempt(run) {
  const value = Number(run?.run_attempt ?? run?.attempt ?? 1);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

/** Select the newest successful Engine CI run for the exact pinned SHA. */
export function selectEngineRun({runs, engineSha, workflowPath = DEFAULT_ENGINE_WORKFLOW_PATH}) {
  const candidates = runs
    .filter((run) => (
      run?.head_sha === engineSha &&
      run?.status === 'completed' &&
      run?.conclusion === 'success' &&
      run?.path === workflowPath
    ))
    .sort((left, right) => (
      timestamp(right.run_started_at ?? right.updated_at ?? right.created_at) -
        timestamp(left.run_started_at ?? left.updated_at ?? left.created_at) ||
      Number(right.id ?? 0) - Number(left.id ?? 0)
    ));
  return candidates[0] ?? null;
}

/** Select the canonical or transfer-retry core artifact from one Engine run. */
export function selectCoreArtifact({artifacts, run}) {
  const attempt = runAttempt(run);
  const canonicalName = `core-build-a${attempt}`;
  const candidates = artifacts
    .filter((artifact) => (
      artifact?.expired !== true &&
      typeof artifact?.name === 'string' &&
      CORE_ARTIFACT_NAME.test(artifact.name) &&
      (artifact.name === canonicalName || artifact.name.startsWith(`${canonicalName}-retry-`))
    ))
    .sort((left, right) => {
      const leftRank = left.name === canonicalName ? 0 : left.name.includes('-retry-1-') ? 1 : 2;
      const rightRank = right.name === canonicalName ? 0 : right.name.includes('-retry-1-') ? 1 : 2;
      return leftRank - rightRank || (
        timestamp(right.updated_at ?? right.created_at) - timestamp(left.updated_at ?? left.created_at)
      );
    });
  return candidates[0] ?? null;
}

function walkFiles(root, callback) {
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const info = statSync(path);
    if (info.isDirectory()) walkFiles(path, callback);
    else if (info.isFile()) callback(path);
  }
}

function hasFiles(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) return false;
  let count = 0;
  walkFiles(root, () => { count += 1; });
  return count > 0;
}

/** Verify the minimum layout needed by every Editor prerequisite consumer. */
export function verifyEngineArtifact({engineRoot}) {
  const packagesRoot = join(engineRoot, 'packages');
  if (!existsSync(packagesRoot) || !statSync(packagesRoot).isDirectory()) {
    throw failure('engine-artifact-layout-invalid', `missing ${packagesRoot}`);
  }

  let packageCount = 0;
  let esmCount = 0;
  let declarationCount = 0;
  for (const packageName of readdirSync(packagesRoot).sort()) {
    const dist = join(packagesRoot, packageName, 'dist');
    if (!existsSync(dist) || !statSync(dist).isDirectory()) continue;
    packageCount += 1;
    walkFiles(dist, (path) => {
      if (path.endsWith('.mjs')) esmCount += 1;
      if (path.endsWith('.d.ts')) declarationCount += 1;
    });
  }
  if (packageCount === 0 || esmCount === 0 || declarationCount === 0) {
    throw failure(
      'engine-artifact-layout-invalid',
      `expected Engine package dist with .mjs and .d.ts files, observed packages=${packageCount}, mjs=${esmCount}, dts=${declarationCount}`,
    );
  }
  for (const requiredPath of ['packages/wgpu-wasm/pkg', 'packages/fbx/pkg']) {
    if (!hasFiles(join(engineRoot, requiredPath))) {
      throw failure('engine-artifact-layout-invalid', `missing or empty ${join(engineRoot, requiredPath)}`);
    }
  }
  return {packageCount, esmCount, declarationCount};
}

function findArtifactRoot(downloadDir) {
  const candidates = [downloadDir];
  for (const firstLevel of readdirSync(downloadDir).sort()) {
    const path = join(downloadDir, firstLevel);
    if (statSync(path).isDirectory()) candidates.push(path);
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'packages'))) return candidate;
  }
  throw failure('engine-artifact-layout-invalid', `downloaded artifact has no packages directory under ${downloadDir}`);
}

export function installCoreArtifact({artifactRoot, engineRoot}) {
  const sourcePackages = join(artifactRoot, 'packages');
  if (!existsSync(sourcePackages) || !statSync(sourcePackages).isDirectory()) {
    throw failure('engine-artifact-layout-invalid', `missing ${sourcePackages}`);
  }
  const targetPackages = join(engineRoot, 'packages');
  mkdirSync(targetPackages, {recursive: true});
  for (const packageName of readdirSync(sourcePackages).sort()) {
    const source = join(sourcePackages, packageName);
    if (!statSync(source).isDirectory()) continue;
    cpSync(source, join(targetPackages, packageName), {recursive: true, force: true});
  }
  return verifyEngineArtifact({engineRoot});
}

function command(commandName, args, {cwd = process.cwd()} = {}) {
  return execFileSync(commandName, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function ghApiCollection(runCommand, {cwd, endpoint, collectionKey}) {
  const output = runCommand(
    'gh',
    ['api', '--paginate', '--jq', `.${collectionKey}[]`, endpoint],
    {cwd},
  );
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function pinnedEngineSha({cwd, runCommand = command}) {
  const value = runCommand('git', ['-C', 'packages/engine', 'rev-parse', 'HEAD'], {cwd}).trim();
  if (!/^[0-9a-f]{40}$/.test(value)) throw failure('engine-pin-invalid', `observed ${value || '<empty>'}`);
  return value;
}

/** Hydrate packages/engine from Engine CI without running Engine build logic here. */
export function hydrateEngineArtifact({
  cwd = process.cwd(),
  engineRepository = process.env.ENGINE_REPOSITORY ?? DEFAULT_ENGINE_REPOSITORY,
  engineWorkflowPath = process.env.ENGINE_WORKFLOW_PATH ?? DEFAULT_ENGINE_WORKFLOW_PATH,
  engineRoot = resolve(cwd, 'packages/engine'),
  runCommand = command,
} = {}) {
  const engineSha = pinnedEngineSha({cwd, runCommand});
  const run = selectEngineRun({
    runs: ghApiCollection(runCommand, {
      cwd,
      endpoint: `repos/${engineRepository}/actions/runs?head_sha=${engineSha}&per_page=100`,
      collectionKey: 'workflow_runs',
    }),
    engineSha,
    workflowPath: engineWorkflowPath,
  });
  if (!run) {
    throw failure(
      'engine-core-artifact-unavailable',
      `no successful ${engineWorkflowPath} run for Engine SHA ${engineSha} in ${engineRepository}`,
    );
  }

  const artifact = selectCoreArtifact({
    artifacts: ghApiCollection(runCommand, {
      cwd,
      endpoint: `repos/${engineRepository}/actions/runs/${run.id}/artifacts?per_page=100`,
      collectionKey: 'artifacts',
    }),
    run,
  });
  if (!artifact) {
    throw failure(
      'engine-core-artifact-unavailable',
      `successful Engine run ${run.id} has no unexpired core-build artifact for attempt ${runAttempt(run)}`,
    );
  }

  const downloadDir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'forgeax-engine-core-'));
  try {
    runCommand(
      'gh',
      ['run', 'download', String(run.id), '--repo', engineRepository, '--name', artifact.name, '--dir', downloadDir],
      {cwd},
    );
    const artifactRoot = findArtifactRoot(downloadDir);
    const layout = installCoreArtifact({artifactRoot, engineRoot});
    return {
      ok: true,
      engineRepository,
      engineSha,
      engineRunId: run.id,
      engineRunAttempt: runAttempt(run),
      artifactId: artifact.id,
      artifactName: artifact.name,
      layout,
    };
  } finally {
    rmSync(downloadDir, {recursive: true, force: true});
  }
}

function main() {
  try {
    process.stdout.write(`${JSON.stringify(hydrateEngineArtifact(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`engine-artifact-hydration-failed: ${error.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) main();
