#!/usr/bin/env node
// validate-gateway-skill.mjs -- M5 skill content anchor validation
// (feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop, m5-w4).
//
// Validates that skills/forgeax-editor-gateway/SKILL.md exists and contains
// the required content anchors (plan-strategy D-8).
//
// Checks:
//   1. File existence: skills/forgeax-editor-gateway/SKILL.md
//   2. Frontmatter validity: YAML frontmatter with at least `name` field,
//      and name MUST equal 'forgeax-editor-gateway'
//   3. Keyword anchors: body text must contain ALL five keywords
//      (case-insensitive): dispatch, begin, commit, listOps, defineOp
//
// Does NOT validate symlink placement (D-8: symlink verification belongs
// to verify step local sandbox, not CI).
//
// Usage: node scripts/validate-gateway-skill.mjs [skillDir]
//        Default: skills/forgeax-editor-gateway (relative to repo root)
// Exits: 0 valid / 1 missing or invalid

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// The skill directory relative to repo root
const skillDirArg = process.argv[2];
const skillDir = skillDirArg
  ? resolve(skillDirArg)
  : resolve(REPO_ROOT, 'skills', 'forgeax-editor-gateway');
const skillFile = join(skillDir, 'SKILL.md');

const EXPECTED_NAME = 'forgeax-editor-gateway';

// Required keyword anchors (case-insensitive search in body text)
const REQUIRED_KEYWORDS = [
  // M1 closed-loop anchors (kept)
  'dispatch',
  'begin',
  'commit',
  'listOps',
  'defineOp',
  // M5 eval + scope + trace anchors (plan-strategy §5.6 AC-20)
  'eval',
  'scope',
  'trace',
  'querySnapshot',
  // Gateway public collection/duplicate contract and the engine-dist red line.
  'collectSceneAsset',
  'duplicateEntity',
  'engine `dist`',
  // The DEV-only, loopback-only live-window CLI path.
  'gateway-live.mjs',
  'FORGEAX_BRIDGE',
  '127.0.0.1',
  // Undo/redo timeline family — a docs-following AI that only reads the Core API
  // table must find these. They return a bare boolean, not DispatchResult; a
  // dropped row silently mis-teaches `gateway.undo().ok` (EXPERIMENT-REPORT
  // round-2 friction #1).
  'undo',
  'canUndo',
  // Asset-resident plugin authoring (`*.plugin.ts` under assets/) — the whole
  // capability was invisible to a docs-only AI until round-3. These anchors keep
  // the "Author asset-resident game logic" section from silently vanishing
  // (EXPERIMENT-REPORT round-3 friction #1).
  '.plugin.ts',
  'defineSystem',
  // Scoped-plan authoring — the most common composed-op shape is "operate on a
  // parent's children", but Children.entities serializes to an opaque count, so a
  // plan MUST reverse-scan ChildOf (the SSOT; Children is its derived mirror).
  // The defineOp section only showed a whole-table scan until round-4; this anchor
  // keeps the "enumerate a parent's children" example from vanishing
  // (EXPERIMENT-REPORT round-4 friction #1; round-2 deferred #3).
  'ChildOf',
// Dispatching a composed op: args are TOP-LEVEL (not nested under `args`) and
  // argsSchema is ENFORCED at dispatch for defined ops. Without this section a
  // docs-only AI defines an op it cannot correctly call, and trusts a schema that
  // used to be decorative (EXPERIMENT-REPORT round-4 friction #1/#2).
  'Dispatch a composed op',
  // RHI frame capture (render-debug) — an ENGINE capability reached via
  // globalThis.__forgeax.captureFrame, deliberately OUTSIDE the gateway (not an
  // op). A docs-only AI reading the "one door" narrative could not find how to
  // capture a frame until round-4 (rhi-debug). These anchors keep the "Debug
  // rendering" section (which also states WHY it's out-of-door) from vanishing.
  'captureFrame',
  '__forgeax',
  // Asset WRITE legs — import a file into the catalog + place a catalogued scene
  // GUID into the world. The read legs were documented but the write legs (and the
  // last-leg `addSceneAssetToScene`) were invisible to a docs-only AI: it could
  // import (via listOps discovery) but had no documented path to PLACE the result,
  // so the whole import→instantiate chain dead-ended (EXPERIMENT-REPORT round-6
  // friction #1/#3). These anchors keep the "Import an external asset, then place
  // it" section from silently vanishing.
  'importAsset',
  'addSceneAssetToScene',
  // Async scene mounts must be polled through their own terminal lifecycle;
  // a wrapper entity or immediate `{ok:true}` is not a completion signal.
  // Keeps the r28 observability repair and r29 component-first verification
  // recipe visible to a docs-only driver.
  'sceneMountPhase',
  'lastSceneMountError',
  // Empty-scene launch trap — `dev:standalone` (no --game) opens an EMPTY scene, so
  // Play degrades to a no-op while `dispatch({kind:'play'})` still returns {ok:true}.
  // Rounds 3 & 5 both misdiagnosed this (blamed async flip / escalated a non-bug).
  // The Scripts prereq must keep telling a docs-only AI to boot `fx start --game`
  // for real Play dogfood (EXPERIMENT-REPORT round-8 friction #1/#3).
  'fx start --game',
  // Terminal-aware play lifecycle — `play` assembly is async + can fail; a
  // `mode`-only poller waits forever on a degraded assemble. The doc MUST teach
  // polling `playPhase` to a TERMINAL value (play|failed) + reading lastPlayError
  // on failure. Keeps the round-8 #3 fix's projection from silently reverting to
  // the old "poll mode" band-aid (EXPERIMENT-REPORT round-8 friction #3).
  'playPhase',
  'lastPlayError',
  // Lightweight by-GUID asset read leg — a material POD exposes its texture
  // bindings as GUID strings; the only by-GUID path used to be lookupAsset, which
  // returns the FULL payload (a texture's whole pixel buffer → multi-MB dump). The
  // "Read what asset an entity references" section MUST keep teaching
  // describeAssetByGuid (identity + buffer-stripped `meta`) as the way to follow a
  // GUID pointer without a context-bomb (EXPERIMENT-REPORT round-9 friction #4).
  'describeAssetByGuid',
];

// ---------------------------------------------------------------------------
// Check 1: File existence
// ---------------------------------------------------------------------------
if (!existsSync(skillFile)) {
  console.error(
    `[validate-gateway-skill] MISSING: SKILL.md not found at ${skillFile}`,
  );
  console.error(
    '[validate-gateway-skill] Expected path: skills/forgeax-editor-gateway/SKILL.md',
  );
  process.exit(1);
}

const rawContent = readFileSync(skillFile, 'utf8');

// ---------------------------------------------------------------------------
// Check 2: Frontmatter (YAML between --- delimiters)
// ---------------------------------------------------------------------------
const lines = rawContent.split('\n');
let frontmatter = null;
let bodyStartLine = 0;

if (lines[0] && lines[0].trim() === '---') {
  // Find closing ---
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      frontmatter = lines.slice(1, i).join('\n');
      bodyStartLine = i + 1;
      break;
    }
  }
}

if (frontmatter === null) {
  console.error(
    '[validate-gateway-skill] INVALID: missing or malformed YAML frontmatter',
  );
  console.error('[validate-gateway-skill] SKILL.md must start with --- and include a name field');
  process.exit(1);
}

if (frontmatter.trim() === '') {
  console.error(
    '[validate-gateway-skill] INVALID: frontmatter is empty (no fields)',
  );
  console.error('[validate-gateway-skill] Required: name: forgeax-editor-gateway');
  process.exit(1);
}

// Parse name field from frontmatter (simple YAML key: value)
const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
if (!nameMatch) {
  console.error(
    '[validate-gateway-skill] INVALID: frontmatter missing required "name" field',
  );
  console.error(`[validate-gateway-skill] Expected: name: ${EXPECTED_NAME}`);
  process.exit(1);
}

const nameValue = nameMatch[1].trim();
if (nameValue !== EXPECTED_NAME) {
  console.error(
    `[validate-gateway-skill] INVALID: frontmatter name must be "${EXPECTED_NAME}", got "${nameValue}"`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Check 3: Keyword anchors (case-insensitive)
// ---------------------------------------------------------------------------
const bodyText = lines.slice(bodyStartLine).join('\n');
const lowerBody = bodyText.toLowerCase();

const missingKeywords = [];
for (const kw of REQUIRED_KEYWORDS) {
  if (!lowerBody.includes(kw.toLowerCase())) {
    missingKeywords.push(kw);
  }
}

if (missingKeywords.length > 0) {
  console.error(
    `[validate-gateway-skill] INVALID: missing keyword anchor(s): ${missingKeywords.join(', ')}`,
  );
  console.error(
    `[validate-gateway-skill] Required keywords (case-insensitive): ${REQUIRED_KEYWORDS.join(', ')}`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// All checks passed
// ---------------------------------------------------------------------------
console.log(
  `[validate-gateway-skill] OK -- ${skillFile} exists, frontmatter valid, all keyword anchors present`,
);
process.exit(0);