import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('standalone backend boots with the Engine authoring gateway and current templates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'editor-backend-boot-'));
  const gameDir = join(root, 'game-slot');
  mkdirSync(join(gameDir, 'assets'), { recursive: true });
  const child = spawn(process.execPath, ['apps/standalone/game-backend.ts'], {
    cwd: resolve(import.meta.dir, '../../..'),
    env: { ...process.env, FORGEAX_GAME_DIR: gameDir, FORGEAX_GAME_API_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  try {
    const deadline = Date.now() + 10000;
    let url: string | undefined;
    while (Date.now() < deadline) {
      url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url || child.exitCode !== null) break;
      await Bun.sleep(25);
    }
    if (!url) throw new Error(`Backend did not start: ${output}`);
    expect((await fetch(`${url}/api/health`)).ok).toBe(true);
    const response = await fetch(`${url}/api/assets/source/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'boot-list', operation: 'asset.list' }),
    });
    expect(await response.json()).toMatchObject({ ok: true });
    const templates = await (await fetch(`${url}/api/projects/templates`)).json();
    expect(JSON.stringify(templates)).toContain('game-3d');
    // resolveLaunchableGameTemplate returns null for an unknown template slug;
    // the standalone create-game handler must surface that as a 404 so the
    // catalog and the host share one launchability contract (charter S9).
    const notFound = await fetch(`${url}/api/games`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'game-slot', template: 'zzz-nonexistent-template' }),
    });
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toMatchObject({
      ok: false,
      error: 'template not found: zzz-nonexistent-template',
    });
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 15000 });
