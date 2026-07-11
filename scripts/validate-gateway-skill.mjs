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