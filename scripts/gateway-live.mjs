#!/usr/bin/env node
// gateway-live.mjs — drive the ALREADY-OPEN editor window via the DEV bridge.
//
// Contrast with gateway-eval.mjs: that boots a fresh HEADLESS browser (separate
// instance, shares only the disk backend). This one POSTs a JS snippet to the
// loopback relay (gateway-bridge-server.mjs), which forwards it to the live page
// bridge → __forgeaxEval.eval in YOUR open window. Same in-memory world; a
// spawnEntity shows up in the Hierarchy immediately, no save+refresh.
//
// Prereqs: dev stack running (relay on :15295 + editor page open at :15290 with
// the bridge connected). Prints the {ok, value|error} envelope as JSON.
// Exit 1 when the relay/page is unreachable or eval failed at channel level.
//
//   node scripts/gateway-live.mjs "gateway.listOps().length"
//   node scripts/gateway-live.mjs --file snippet.js
//   node scripts/gateway-live.mjs --health
//   FORGEAX_BRIDGE_PORT=15295 node scripts/gateway-live.mjs "<code>"

import { readFileSync } from 'node:fs';

const PORT = Number(process.env.FORGEAX_BRIDGE_PORT ?? 15295);
const BASE = `http://127.0.0.1:${PORT}`;

const argv = process.argv.slice(2);
if (argv.includes('--health')) {
  try {
    const r = await fetch(`${BASE}/health`);
    const j = await r.json();
    console.log(JSON.stringify(j, null, 2));
    process.exit(j.pageConnected ? 0 : 1);
  } catch (e) {
    console.error(`relay unreachable on ${BASE} — is the dev stack up? (${e.message})`);
    process.exit(1);
  }
}

let code;
const fileFlag = argv.indexOf('--file');
if (fileFlag !== -1) {
  code = readFileSync(argv[fileFlag + 1], 'utf8');
} else {
  code = argv.filter((a) => !a.startsWith('--')).join(' ');
}
if (!code) {
  console.error('usage: gateway-live.mjs "<js code>" | --file <path> | --health');
  process.exit(2);
}

let out;
try {
  const r = await fetch(`${BASE}/eval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  out = await r.json();
} catch (e) {
  console.error(`relay unreachable on ${BASE} — start it: node scripts/gateway-bridge-server.mjs (${e.message})`);
  process.exit(1);
}

console.log(JSON.stringify(out, null, 2));
process.exit(out?.ok ? 0 : 1);
