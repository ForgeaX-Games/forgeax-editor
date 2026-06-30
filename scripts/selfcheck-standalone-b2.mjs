// selfcheck-standalone-b2.mjs — proves the standalone editor reaches SELF-BOOT
// level B2 (reuse backend L1 → real read + WRITE) with NO studio server.
//
// R3 (ideal-clean-architecture.md §6): the standalone game backend is
// @forgeax/platform-io's createFilesRouter confined to one --game dir, run as a
// bun process (standalone/game-backend.ts) that the :15290 host vite proxies
// /api → . This script boots BOTH (backend bun process + host vite, NO studio
// server, NO edit-runtime) and exercises the /api/files wire end to end:
//   1. GET /api/files/tree?root=<slug>      → tree rooted at slug (client space)
//   2. GET /api/files?path=<slug>/forge.json → reads existing content
//   3. POST /api/files {path:<slug>/scenes/x.pack.json, content} → WRITE (B2!)
//   4. GET the just-written path                → persisted content matches
//   5. write outside the game (../escape)       → rejected (confinement holds)
//   6. prefs wire (createPrefsRouter, the 2nd reused L1 router): GET empty
//      workspace-layout → 200 json null; PUT a layout → ok; GET back → persisted
//   7. tree optional=1: absent dir &optional=1 → 200 {tree:null}; without it → 404
//
// B0/B1 (can't start / read-only) would fail step 3. A studio server running is
// NOT required (and not started) — that's the whole point of the fast track.
//
// Run: bun scripts/selfcheck-standalone-b2.mjs   (bun: vite.config uses Bun.file)

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EDITOR_DIR = resolve(HERE, '..');
const PORT = 15290;
const GAME_API_PORT = 15281;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function waitFor(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true; // server is answering
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  // 1. scratch game dir (never touch a real game) with a sibling secret.
  const tmp = await mkdtemp(join(tmpdir(), 'fx-b2-'));
  const gameDir = resolve(tmp, 'selfcheck-game');
  const slug = basename(gameDir);
  await mkdir(resolve(gameDir, 'scenes'), { recursive: true });
  await writeFile(resolve(gameDir, 'forge.json'), JSON.stringify({ name: slug, scenes: [] }));
  await writeFile(resolve(tmp, 'secret.txt'), 'top secret');

  // 2. boot the game-backend bun process + the host vite (which proxies /api →
  //    the backend). No edit-runtime, no studio server — that's the B2 claim.
  const env = {
    ...process.env,
    FORGEAX_GAME_DIR: gameDir,
    FORGEAX_GAME_API_PORT: String(GAME_API_PORT),
  };
  const backend = spawn('bun', ['standalone/game-backend.ts'], {
    cwd: EDITOR_DIR, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const child = spawn('bun', ['run', 'dev'], {
    cwd: EDITOR_DIR, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  for (const c of [backend, child]) {
    c.stdout.on('data', (d) => { log += d; });
    c.stderr.on('data', (d) => { log += d; });
  }

  const cleanup = async () => {
    try { backend.kill('SIGTERM'); } catch { /* ignore */ }
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    await rm(tmp, { recursive: true, force: true });
  };

  try {
    const up = await waitFor(`${BASE}/api/files/tree?root=${encodeURIComponent(slug)}`);
    if (!up) {
      console.error('host :15290 never came up. Recent log:\n' + log.slice(-1500));
      process.exitCode = 1;
      return;
    }

    // (1) tree — rooted at slug, client-space paths
    {
      const r = await fetch(`${BASE}/api/files/tree?root=${encodeURIComponent(slug)}`);
      const body = await r.json();
      check('GET /api/files/tree → 200', r.status === 200, `status ${r.status}`);
      check('tree.path === slug (client space)', body?.tree?.path === slug, JSON.stringify(body?.tree?.path));
      const names = (body?.tree?.children ?? []).map((n) => n.name);
      check('tree contains forge.json + scenes', names.includes('forge.json') && names.includes('scenes'), names.join(','));
    }

    // (2) read existing file
    {
      const r = await fetch(`${BASE}/api/files?path=${encodeURIComponent(`${slug}/forge.json`)}`);
      const body = await r.json();
      check('GET /api/files (read) → 200', r.status === 200, `status ${r.status}`);
      check('read content includes slug', typeof body?.content === 'string' && body.content.includes(slug));
    }

    // (3) WRITE — the B2 gate the read-only middleware would fail
    const writePath = `${slug}/scenes/selfcheck.pack.json`;
    const payload = JSON.stringify({ ok: true, ts: 'b2' });
    {
      const r = await fetch(`${BASE}/api/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: writePath, content: payload }),
      });
      const body = await r.json();
      check('POST /api/files (WRITE) → 200', r.status === 200, `status ${r.status} ${JSON.stringify(body)}`);
      check('write reports bytes', typeof body?.bytes === 'number' && body.bytes > 0);
    }

    // (4) read it back — persistence
    {
      const r = await fetch(`${BASE}/api/files?path=${encodeURIComponent(writePath)}`);
      const body = await r.json();
      check('GET written file → persisted content matches', body?.content === payload, JSON.stringify(body?.content));
    }

    // (5) confinement — escape the game dir → rejected
    {
      const r = await fetch(`${BASE}/api/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: `${slug}/../secret.txt`, content: 'pwned' }),
      });
      check('POST escaping game dir → rejected (400)', r.status === 400, `status ${r.status}`);
    }

    // (6) prefs wire — the SECOND reused platform-io L1 router (createPrefsRouter,
    //     §5 复用不另写后端). The client GET/PUTs /api/prefs/workspace-layout/* on
    //     boot + every layout change; without this router those 404'd in --game
    //     mode. Gate it the same way as /api/files so the reuse can't be焊回去.
    {
      // empty workspace-layout → 200 + json null (not 404, not SPA html)
      const rGet = await fetch(`${BASE}/api/prefs/workspace-layout/preview`);
      const ct = rGet.headers.get('content-type') ?? '';
      check('GET /api/prefs/workspace-layout → 200 json', rGet.status === 200 && ct.includes('application/json'), `status ${rGet.status} ct ${ct}`);
      check('empty layout → null', (await rGet.json()) === null);

      // PUT a layout → ok, then GET it back (persists under <game>/.forgeax/prefs)
      const layout = { panels: { main: {} }, ts: 'b2-prefs' };
      const rPut = await fetch(`${BASE}/api/prefs/workspace-layout/preview`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(layout),
      });
      const putBody = await rPut.json();
      check('PUT /api/prefs/workspace-layout → 200 ok', rPut.status === 200 && putBody?.ok === true, `status ${rPut.status} ${JSON.stringify(putBody)}`);

      const rBack = await fetch(`${BASE}/api/prefs/workspace-layout/preview`);
      const back = await rBack.json();
      check('GET written layout → persisted content matches', back?.ts === 'b2-prefs', JSON.stringify(back));
    }

    // (7) tree optional=1 — expected-absent dir probes (editor scene/asset
    //     discovery scans scenes/ & assets/{monsters,characters}/, absent in a
    //     fresh game). optional=1 → 200 { tree:null } so no red 404 in the
    //     network panel; WITHOUT optional the 404 default must hold (the escape
    //     hatch must not loosen genuine missing-dir errors other callers rely on).
    {
      const absent = `${slug}/no-such-dir`;
      const rOpt = await fetch(`${BASE}/api/files/tree?root=${encodeURIComponent(absent)}&optional=1`);
      const optBody = await rOpt.json();
      check('GET /api/files/tree absent &optional=1 → 200 {tree:null}', rOpt.status === 200 && optBody?.tree === null, `status ${rOpt.status} ${JSON.stringify(optBody)}`);

      const rReq = await fetch(`${BASE}/api/files/tree?root=${encodeURIComponent(absent)}`);
      check('GET /api/files/tree absent (no optional) → 404 (default held)', rReq.status === 404, `status ${rReq.status}`);
    }
  } finally {
    await cleanup();
  }

  console.log(`\nB2 self-boot: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
