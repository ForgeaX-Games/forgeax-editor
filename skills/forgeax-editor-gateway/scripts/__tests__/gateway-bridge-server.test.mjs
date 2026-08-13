#!/usr/bin/env node
// Regression for long-running live evals: captureFrame is an async operation
// and must not be discarded by the relay's short transport timeout.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const RELAY = new URL('../gateway-bridge-server.mjs', import.meta.url);

test('bridge reports its long-eval timeout and accepts a per-request timeout', async () => {
  const port = 16000 + (process.pid % 500);
  const child = spawn('bun', [fileURLToPath(RELAY)], {
    env: { ...process.env, FORGEAX_BRIDGE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForHealth(`${base}/health`);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.evalTimeoutMs, 120_000);

    const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    const responsePromise = fetch(`${base}/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'captureFrame()', timeoutMs: 2_000 }),
    });
    const message = await new Promise((resolve, reject) => {
      socket.addEventListener('message', (event) => resolve(event.data), { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    const request = JSON.parse(String(message));
    assert.equal(request.type, 'eval');
    socket.send(JSON.stringify({
      type: 'result',
      id: request.id,
      payload: { ok: true, value: 'completed-after-30s-class-of-bug' },
    }));

    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      value: 'completed-after-30s-class-of-bug',
    });
    socket.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => undefined);
    }
  }
});

test('bridge reports the configured editor URL when no page is attached', async () => {
  const port = 17000 + (process.pid % 500);
  const child = spawn('bun', [fileURLToPath(RELAY)], {
    env: {
      ...process.env,
      FORGEAX_BRIDGE_PORT: String(port),
      FORGEAX_STANDALONE_PORT: '16290',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForHealth(`${base}/health`);
    const response = await fetch(`${base}/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '1 + 1' }),
    });
    assert.deepEqual(await response.json(), {
      ok: false,
      error: {
        code: 'PAGE_NOT_CONNECTED',
        hint: 'no editor page attached to the bridge; open/refresh the editor at http://localhost:16290/',
      },
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => undefined);
    }
  }
});

async function waitForHealth(url) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The relay is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`relay did not start at ${url}`);
}
