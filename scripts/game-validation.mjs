// game-validation.mjs — J5 project-level content validation.
//
// This is intentionally a pre-build query, not a second editor persistence
// format. Manifest validation comes from engine-project; asset roots and pack
// shell validation come from the editor/engine SSOTs. The result is structured
// so a CLI, UI, or AI caller can locate the blocking fact without scraping logs.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGameProjectSync } from '../packages/engine/packages/engine-project/dist/index.mjs';
import { resolveGameAssetRoots, readDeclaredRoots } from '../packages/core/src/asset-roots.ts';
import { CUBE_GUID, SPHERE_GUID, validatePackShell } from '../packages/core/src/scene/scene-pack.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED_BASE = resolve(ROOT, 'forgeax-editor-assets');
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_ENTITIES = 100_000;
const CYLINDER_GUID = 'c1111111-0000-5000-8000-000000000001';

function walk(root, out = []) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const abs = join(root, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

function issue(code, file, message, detail = {}) {
  return { code, file, message, detail };
}

function safeJson(file) {
  try { return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

function rel(root, file) { return relative(root, file).split(sep).join('/'); }

/** @param {string} gameDir @param {{maxBytes?: number, maxEntities?: number}} [options] */
export function validateGameProject(gameDir, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntities = options.maxEntities ?? DEFAULT_MAX_ENTITIES;
  const blocking = [];
  const warnings = [];
  const forgePath = join(gameDir, 'forge.json');
  const manifestResult = loadGameProjectSync((path) => readFileSync(join(gameDir, path), 'utf8'));
  if (!manifestResult.ok) {
    blocking.push(issue(`manifest-${manifestResult.error.code}`, rel(gameDir, forgePath), manifestResult.error.hint, manifestResult.error.detail));
    return { ok: false, gameDir, blocking, warnings, stats: { bytes: 0, entities: 0, packs: 0, sidecars: 0 } };
  }
  const manifest = manifestResult.value;

  const entry = typeof manifest.entry === 'string' && manifest.entry.length > 0 ? manifest.entry : 'main.ts';
  const entryPath = resolve(gameDir, entry);
  if (!entryPath.startsWith(`${gameDir}${sep}`) || !statSafe(entryPath)?.isFile()) {
    blocking.push(issue('missing-entry', rel(gameDir, forgePath), `entry '${entry}' does not exist inside the game directory`, { entry }));
  }

  const declaredRoots = readDeclaredRoots(gameDir);
  for (const declared of declaredRoots) {
    if (declared.startsWith('@shared/')) continue;
    const root = resolve(gameDir, declared);
    if (!statSafe(root)?.isDirectory()) blocking.push(issue('asset-root-missing', rel(gameDir, join('package.json')), `declared asset root '${declared}' does not exist`, { root: declared }));
  }
  const roots = resolveGameAssetRoots(gameDir, {
    sharedBase: SHARED_BASE,
    implicitSharedSubs: ['template-game-default'],
  });
  const files = roots.flatMap((root) => walk(root.abs));
  const uniqueFiles = [...new Set(files)];
  const packFiles = uniqueFiles.filter((file) => file.endsWith('.pack.json'));
  const sidecarFiles = uniqueFiles.filter((file) => file.endsWith('.meta.json') && !file.endsWith('.pack.json'));
  const knownGuids = new Set([CUBE_GUID, SPHERE_GUID, CYLINDER_GUID]);
  const refs = [];
  let bytes = 0;
  let entities = 0;

  for (const file of uniqueFiles) {
    const size = statSafe(file)?.size ?? 0;
    bytes += size;
  }
  if (bytes > maxBytes) blocking.push(issue('budget-overrun', rel(gameDir, 'package.json'), `asset roots use ${bytes} bytes, above the ${maxBytes}-byte build budget`, { bytes, maxBytes }));

  for (const file of packFiles) {
    const parsed = safeJson(file);
    if (!parsed.ok) {
      blocking.push(issue('unserializable-component', rel(gameDir, file), `pack JSON cannot be parsed: ${parsed.error}`));
      continue;
    }
    const shell = validatePackShell(parsed.value);
    if (!shell.ok) {
      blocking.push(issue('unserializable-component', rel(gameDir, file), shell.error.hint, { issues: shell.error.issues }));
      continue;
    }
    for (const asset of shell.pack.assets) {
      knownGuids.add(asset.guid);
      for (const ref of asset.refs) refs.push({ file, asset: asset.guid, ref });
      if (asset.kind === 'scene') {
        const payload = asset.payload;
        if (!payload || typeof payload !== 'object' || !Array.isArray(payload.entities)) {
          blocking.push(issue('unserializable-component', rel(gameDir, file), `scene asset ${asset.guid} has no serializable entities payload`, { guid: asset.guid }));
        } else {
          entities += payload.entities.length;
          for (const node of payload.entities) {
            if (!node || typeof node !== 'object' || typeof node.localId !== 'number' || !node.components || typeof node.components !== 'object') {
              blocking.push(issue('unserializable-component', rel(gameDir, file), `scene asset ${asset.guid} contains an invalid entity/component record`, { guid: asset.guid }));
            }
          }
        }
      }
    }
  }
  if (entities > maxEntities) blocking.push(issue('budget-overrun', rel(gameDir, 'package.json'), `scene entities use ${entities}, above the ${maxEntities}-entity build budget`, { entities, maxEntities }));

  for (const file of sidecarFiles) {
    const parsed = safeJson(file);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
      blocking.push(issue('orphan-sidecar', rel(gameDir, file), 'sidecar is not valid JSON metadata'));
      continue;
    }
    const source = parsed.value.source;
    const sourcePath = typeof source === 'string' ? resolve(dirname(file), source) : '';
    const subAssets = parsed.value.subAssets;
    if (!sourcePath || !statSafe(sourcePath)?.isFile() || !Array.isArray(subAssets) || subAssets.length === 0) {
      blocking.push(issue('orphan-sidecar', rel(gameDir, file), 'sidecar has no existing source or sub-assets', { source, sourcePath: sourcePath ? rel(gameDir, sourcePath) : null }));
    } else {
      for (const sub of subAssets) if (typeof sub?.guid === 'string') knownGuids.add(sub.guid);
    }
  }

  for (const ref of refs) {
    if (!knownGuids.has(ref.ref)) blocking.push(issue('missing-reference', rel(gameDir, ref.file), `asset ${ref.asset} references missing GUID ${ref.ref}`, ref));
  }

  if (manifest.defaultScene && !knownGuids.has(manifest.defaultScene)) {
    blocking.push(issue('missing-reference', rel(gameDir, forgePath), `defaultScene references missing GUID ${manifest.defaultScene}`, { ref: manifest.defaultScene }));
  }
  if (manifest.npc?.budget?.maxConcurrent === 0) warnings.push(issue('budget-zero', rel(gameDir, forgePath), 'npc budget maxConcurrent is zero; the feature will never run'));
  return {
    ok: blocking.length === 0,
    gameDir,
    blocking,
    warnings,
    stats: { bytes, entities, packs: packFiles.length, sidecars: sidecarFiles.length },
  };
}

function statSafe(file) {
  try { return statSync(file); } catch { return null; }
}

if (import.meta.main) {
  const gameDir = resolve(process.argv[2] ?? '');
  const options = {};
  for (const arg of process.argv.slice(3)) {
    const match = arg.match(/^--(max-bytes|max-entities)=(\d+)$/);
    if (!match) throw new Error(`unknown validation flag: ${arg}`);
    options[match[1] === 'max-bytes' ? 'maxBytes' : 'maxEntities'] = Number(match[2]);
  }
  const result = validateGameProject(gameDir, options);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
