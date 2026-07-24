#!/usr/bin/env node
// lint-fx-no-studio-port.mjs — static gate: the editor's fx dev-stack must NOT
// manage or launch services on Studio-owned ports :15173 or :15295. Keeps the
// two dev stacks decoupled so they coexist.
//
// WHY THIS EXISTS (the regression it closes — feedback
// 2026-07-13-editor-studio-15173-port-collision.md)
//   studio's superrepo stack (forgeax-studio scripts/run.ts) launches THIS
//   package's play-runtime on :15173 (its PORT_ENGINE default, via `bun x vite`
//   with no FORGEAX_ENGINE_PORT — it relies on play-runtime/vite.config.ts's 15173
//   default). The editor's own `scripts/fx.ts` used to (a) list 15173 in its
//   managed `PORTS` kill-set and (b) launch its play-runtime with an explicit
//   FORGEAX_ENGINE_PORT: '15173'. Because fx's killByPorts is port-based (kills ANY
//   pid on the port, not just its own children) and `start` calls `stop()` as a
//   preflight, every editor-stack start/stop SIGTERM'd studio's engine → studio's
//   browser flooded with :15173 ERR_CONNECTION_REFUSED. The fix pins the editor's
//   own stack to PLAY_RUNTIME_PORT (15273) instead; this gate makes a re-introduction
//   of 15173 into fx.ts turn `bun run lint` red.
//
// SCOPE — scripts/fx.ts ONLY. The raw `bun -F @forgeax/editor-play-runtime dev`
//   path legitimately still defaults to 15173 (play-runtime/vite.config.ts —
//   unchanged, so studio keeps working); we gate the fx ORCHESTRATION, not the
//   vite default. So this checks fx.ts's executable port constants/launch env, not
//   comments (a comment may mention 15173 to explain the decoupling).
//
// Usage:   node scripts/lint-fx-no-studio-port.mjs [--file <path>]
//          (--file defaults to scripts/fx.ts; the self-test feeds synthetic copies)
// Exits    0 no studio-port collision in fx orchestration
//          · 1 15173 present in PORTS/launch or Studio's 15295 appears in executable code
//          · 2 anchor missing/renamed (refuse to pass blind — re-point the gate).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// --file <path> override (default: scripts/fx.ts). Lets the self-test point the
// gate at synthetic copies without touching the real installer.
function parseFileArg(argv) {
  const i = argv.indexOf('--file');
  if (i !== -1 && argv[i + 1]) return resolve(argv[i + 1]);
  return resolve(REPO_ROOT, 'scripts', 'fx.ts');
}

const target = parseFileArg(process.argv.slice(2));

let source;
try {
  source = readFileSync(target, 'utf8');
} catch (e) {
  console.error(`[lint-fx-no-studio-port] cannot read ${target}: ${e.message}`);
  process.exit(2);
}

// Strip line + block comments so a comment that MENTIONS 15173 (to explain the
// decoupling) doesn't trip the gate — we only care about executable port config.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (avoid eating `http://`)

const lines = code.split('\n');

// Anchor — the managed-ports kill-set. Match the `const PORTS = [ ... ]` literal;
// if fx.ts is refactored so this doesn't exist, refuse to pass blind (exit 2).
const PORTS_LINE = /const\s+PORTS\s*=\s*\[[^\]]*\]/;
const portsIdx = lines.findIndex((l) => PORTS_LINE.test(l));
if (portsIdx === -1) {
  console.error(
    `[lint-fx-no-studio-port] anchor not found in ${target}: \`const PORTS = [ ... ]\`.`,
  );
  console.error(
    '  fx.ts was refactored — re-point this gate to the new managed-ports declaration rather than letting it pass blind.',
  );
  process.exit(2);
}

const violations = [];

// (1) 15173 must not appear in the PORTS kill-set literal (would kill studio's engine).
if (/\b15173\b/.test(lines[portsIdx])) {
  violations.push(
    `PORTS kill-set (line ${portsIdx + 1}) contains 15173 — fx's port-based killByPorts would SIGTERM studio's engine. Use PLAY_RUNTIME_PORT.`,
  );
}

// (2) No launch env pins FORGEAX_ENGINE_PORT to 15173 (would collide with studio).
const ENGINE_PORT_15173 = /FORGEAX_ENGINE_PORT\s*:\s*['"]?15173['"]?/;
lines.forEach((l, i) => {
  if (ENGINE_PORT_15173.test(l)) {
    violations.push(
      `line ${i + 1} pins FORGEAX_ENGINE_PORT to 15173 — the editor stack must run its own play-runtime on PLAY_RUNTIME_PORT (15273), not studio's 15173.`,
    );
  }
});

// (3) 15295 is Studio's gateway relay. The editor may explain that port in
// comments, but executable defaults and managed-port declarations must use the
// editor-owned relay port instead.
lines.forEach((l, i) => {
  if (/\b15295\b/.test(l)) {
    violations.push(
      `line ${i + 1} references Studio's gateway port 15295 in executable code — use the editor-owned bridge port (15296 by default).`,
    );
  }
});

if (violations.length > 0) {
  console.error(`[lint-fx-no-studio-port] REGRESSION in ${target}:`);
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    '  studio owns :15173 (play-runtime) and :15295 (gateway); the editor fx stack must stay on 15273 and 15296 so the two coexist.',
  );
  process.exit(1);
}

console.log(
  `[lint-fx-no-studio-port] OK — fx.ts orchestration does not manage or launch on Studio's :15173/:15295.`,
);
process.exit(0);
