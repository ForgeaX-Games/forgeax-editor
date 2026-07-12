#!/usr/bin/env node
// new-run-dir.mjs — mint a solo-loop experiment run directory named
// `<YYYYMMDD>-<HHMMSS>-<goal-slug>` under the harness clone's solo notebook.
//
// WHY this exists: SKILL.md step 0 opens one self-contained run dir per loop. The
// name is `<date>-<time>-<slug>` (compact, colon-free = filesystem-safe, sorts
// lexicographically = chronologically). Hand-typing the timestamp is error-prone
// and Date.now() is banned inside gateway eval snippets — so the shell mints it
// here, once, at step 0. It also scaffolds `snippets/` + `out/` so the run's
// driving code and captured output have a home from the first call (SKILL.md:
// "throwaway driving code — a run that can't be re-run" anti-pattern).
//
// Usage:
//   node skills/forgeax-editor-solo/scripts/new-run-dir.mjs <goal-slug>
//   node skills/forgeax-editor-solo/scripts/new-run-dir.mjs material-texture-round-trip
//
// Flags:
//   --root <dir>   notebook root (default: <repo>/.forgeax-harness/solo/experiments)
//   --print-only   print the computed dir name/path, create nothing
//
// Prints the absolute run-dir path on stdout (last line) so a caller can capture it:
//   RUN=$(node .../new-run-dir.mjs my-goal | tail -1)

import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// scripts/ -> forgeax-editor-solo/ -> skills/ -> <repo root>
const REPO_ROOT = resolve(HERE, '..', '..', '..');

// --- parse args (positional slug + a couple of flags) ---------------------------
const argv = process.argv.slice(2);
let slug = '';
let root = '';
let printOnly = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--print-only') printOnly = true;
  else if (a === '--root') root = argv[++i] ?? '';
  else if (a.startsWith('--root=')) root = a.slice('--root='.length);
  else if (a.startsWith('--')) die(`unknown flag: ${a}`);
  else if (!slug) slug = a;
  else die(`unexpected extra argument: ${a}`);
}
if (!slug) die('need a goal slug, e.g. `new-run-dir.mjs material-texture-round-trip`');

// --- normalize the slug ---------------------------------------------------------
// keep it kebab-case, lowercase, no leading/trailing dashes; reject empties.
const cleanSlug = slug
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');
if (!cleanSlug) die(`slug '${slug}' normalizes to empty — use letters/digits`);

// --- compose the compact local timestamp ---------------------------------------
// `<YYYYMMDD>-<HHMMSS>` in LOCAL time (the notebook is read by a human in their tz).
const now = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const date = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
const time = `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
const name = `${date}-${time}-${cleanSlug}`;

const experimentsRoot = root
  ? resolve(root)
  : join(REPO_ROOT, '.forgeax-harness', 'solo', 'experiments');
const runDir = join(experimentsRoot, name);

if (printOnly) {
  process.stdout.write(`name: ${name}\n`);
  process.stdout.write(`${runDir}\n`);
  process.exit(0);
}

if (existsSync(runDir)) die(`run dir already exists: ${runDir}`);
mkdirSync(join(runDir, 'snippets'), { recursive: true });
mkdirSync(join(runDir, 'out'), { recursive: true });

process.stderr.write(`created run dir: ${name}\n  snippets/  out/\n`);
// last stdout line = the path, for `RUN=$(... | tail -1)`
process.stdout.write(`${runDir}\n`);

function die(msg) {
  process.stderr.write(`new-run-dir: ${msg}\n`);
  process.exit(2);
}
