#!/usr/bin/env node

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function normalize(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function invalidSha(value) {
  return !SHA_PATTERN.test(normalize(value));
}

export function checkPrBaseFreshness({ eventName, eventBaseSha, remoteMainSha } = {}) {
  const event = normalize(eventName);
  const baseSha = normalize(eventBaseSha);
  const mainSha = normalize(remoteMainSha);

  if (event !== 'pull_request') {
    return {
      ok: true,
      code: 'not-applicable',
      eventName: event || null,
    };
  }

  if (invalidSha(baseSha)) {
    return {
      ok: false,
      code: 'pr-base-sha-invalid',
      expected: '40-character pull-request base SHA',
      observed: eventBaseSha ?? null,
      hint: 'Read github.event.pull_request.base.sha from the pull_request event payload.',
    };
  }

  if (invalidSha(mainSha)) {
    return {
      ok: false,
      code: 'remote-main-sha-invalid',
      expected: '40-character current origin/main SHA',
      observed: remoteMainSha ?? null,
      hint: 'Resolve the current origin/main ref before admitting the pull request.',
    };
  }

  if (baseSha !== mainSha) {
    return {
      ok: false,
      code: 'pr-base-stale',
      expected: mainSha,
      observed: baseSha,
      hint: 'Update the pull-request branch onto the current main and rerun CI before merging.',
    };
  }

  return {
    ok: true,
    code: 'pr-base-current',
    eventName: event,
    baseSha,
    remoteMainSha: mainSha,
  };
}

function main() {
  const result = checkPrBaseFreshness({
    eventName: process.env.CI_EVENT_NAME ?? process.env.GITHUB_EVENT_NAME,
    eventBaseSha: process.env.CI_PR_BASE_SHA,
    remoteMainSha: process.env.CI_REMOTE_MAIN_SHA,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

const invoked = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (invoked) main();
