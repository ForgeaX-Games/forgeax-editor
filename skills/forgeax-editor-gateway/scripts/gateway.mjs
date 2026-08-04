#!/usr/bin/env node
// gateway.mjs — drive an already-open Editor Gateway realm.
//
// Structured list/dispatch and eval mode use standalone Editor's DEV relay.
// Every mode reaches the attached in-process Gateway; none starts another page.
//
// Prereqs: editor standalone dev stack running (relay on :15296 + editor page open at :15290 with
// the bridge connected). Prints the {ok, value|error} envelope as JSON.
// Exit 1 when the relay/page is unreachable or eval failed at channel level.
//
//   node scripts/gateway.mjs "gateway.listOps().length"
//   node scripts/gateway.mjs --file snippet.js
//   node scripts/gateway.mjs --file capture.js --timeout 120000
//   node scripts/gateway.mjs --health
//   node scripts/gateway.mjs list
//   node scripts/gateway.mjs dispatch play --input '{"dirtyPolicy":"last-saved"}'
//   FORGEAX_BRIDGE_PORT=15296 node scripts/gateway.mjs "<code>"

import { parseArgs, readSnippet, printResult } from './gateway-cli-common.mjs';
import {
  GATEWAY_ATTACHED_USAGE,
  isGatewayAttachedCommand,
  runGatewayAttachedCommand,
} from './gateway-attached-commands.mjs';

const HELP = `Usage:
  node gateway.mjs ${GATEWAY_ATTACHED_USAGE[0]}
  node gateway.mjs ${GATEWAY_ATTACHED_USAGE[1]}
  node gateway.mjs ${GATEWAY_ATTACHED_USAGE[2]}
  node gateway.mjs --health
  node gateway.mjs "<gateway eval snippet>" | --file <path> [--timeout <ms>]

All commands attach to the already-open standalone Editor through its DEV relay.
Product compositions expose their own Gateway command and own their carrier.`;

const rawArgs = process.argv.slice(2);
const port = Number(process.env.FORGEAX_BRIDGE_PORT ?? 15296);
const base = `http://127.0.0.1:${port}`;
if (rawArgs.includes('--help') || rawArgs.includes('-h') || (rawArgs[0] === 'help' && rawArgs.length === 1)) {
  console.log(HELP);
  process.exit(0);
}

if (isGatewayAttachedCommand(rawArgs)) {
  try {
    printResult(await runGatewayAttachedCommand(rawArgs, evaluateAttached));
  } catch (error) {
    printResult({
      ok: false,
      error: {
        code: typeof error?.code === 'string' ? error.code : 'GATEWAY_CLI_ERROR',
        message: error instanceof Error ? error.message : String(error),
        ...(error?.details === undefined ? {} : { details: error.details }),
      },
    });
  }
} else {
  await runEvalMode();
}

async function runEvalMode() {
  // --health is a distinct MODE (not a snippet run) — handle it before parseArgs so
  // the strict parser never sees it as an unknown flag.
  if (process.argv.slice(2).includes('--health')) {
    try {
      const response = await fetch(`${base}/health`);
      const health = await response.json();
      console.log(JSON.stringify(health, null, 2));
      process.exitCode = health.pageConnected ? 0 : 1;
    } catch (error) {
      console.error(`relay unreachable on ${base} — is the dev stack up? (${error.message})`);
      process.exitCode = 1;
    }
    return;
  }

  // Strict spec-driven parse (shared SSOT). Live accepts --file and --timeout (and the
  // special-cased --health above) — so eval-only flags like --settle/--raw now fail
  // loudly instead of leaking their bare value into the code string (the regression
  // that motivated gateway-cli-common.mjs).
  const { code: posCode, flags } = parseArgs(process.argv, {
    value: ['file', 'timeout'],
    number: ['timeout'],
  });
  const code = readSnippet(
    { code: posCode, file: flags.file },
    'usage: gateway.mjs "<js code>" | --file <path> | --health',
  );

  printResult(await evaluateAttached(code, flags.timeout));
}

async function evaluateAttached(code, timeout) {
  try {
    const response = await fetch(`${base}/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, ...(timeout !== undefined ? { timeoutMs: timeout } : {}) }),
    });
    return await response.json();
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'RELAY_UNREACHABLE',
        message: `relay unreachable on ${base} — start it: node scripts/gateway-bridge-server.mjs (${error.message})`,
      },
    };
  }
}
